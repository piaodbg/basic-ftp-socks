import net = require('net');
import { EventEmitter } from 'events';

export class ProxySocket extends EventEmitter {
    public readable = true;
    public writable = true;
    public localPort?: number;
    public localAddress?: string;
    public remotePort?: number | undefined;
    public remoteAddress?: string | undefined;

    private socksHost: string;
    private socksPort: number;
    private realSocket: net.Socket;

    private connecting: boolean = false;
    private connected: boolean = false;

    private connectStage: number = 0;

    private host: string = '';
    private port: number = 0;

    private unSent: [any, any, any][] = [];
    private unPiped: [any, any][] = [];

    private realSocketEncoding: BufferEncoding | undefined ='binary';

    private connectErrors: { [key: number]: string } = {
        0x00: 'request granted',
        0x01: 'general failure',
        0x02: 'connection not allowed by ruleset',
        0x03: 'network unreachable',
        0x04: 'host unreachable',
        0x05: 'connection refused by destination host',
        0x06: 'TTL expired',
        0x07: 'command not supported / protocol error',
        0x08: 'address type not supported'
    };

    constructor(socksHost: string, socksPort: number, socket?: net.Socket) {
        super();
        this.socksHost = socksHost || 'localhost';
        this.socksPort = socksPort || 8888;
        this.realSocket = socket || new net.Socket({
            readable: true,
            writable: true
        });

        this.realSocket.on('data', (buffer: Buffer) => {
            if (this.connected) {
                this.emit('data', buffer);
            } else {
                this.emit('socksdata', buffer);
                this.receiveSocksConnectData(buffer);
            }
        });

        this.realSocket.on('error', (e: Error) => {
            this.emit('error', e);
        });

        this.realSocket.on('end', () => {
            this.writable = false;
            this.emit('end');
        });

        this.realSocket.on('timeout', () => {
            this.emit('timeout');
        });

        this.realSocket.on('close', () => {
            this.writable = false;
            if (this.connected) {
                this.emit('close');
            }
        });

        this.realSocket.on('drain', () => {
            if (this.connected) {
                this.emit('drain');
            }
        });

        this.realSocket.on('readable', () => {
            this.realSocket.read();
            if (this.connected) {
                this.emit('readable');
            }
        });
    }

    public read(size?: number): any {
        if (!this.connected) {
            return null;
        }
        return this.realSocket.read(size);
    }

    public destroy(error?: Error): void {
        this.writable = false;
        this.realSocket.destroy(error);
    }

    public ref(): any {
        return this.realSocket.ref();
    }

    public unref(): any {
        return this.realSocket.unref();
    }

    public setKeepAlive(enable: boolean, initialDelay?: number): any {
        return this.realSocket.setKeepAlive(enable, initialDelay);
    }

    public pipe(dest: any, opts?: any): any {
        if (this.connected) {
            return this.realSocket.pipe(dest, opts);
        }

        this.unPiped.push([dest, opts]);
        return dest;
    }

    public setTimeout(timeout: number, callback?: () => void): any {
        return this.realSocket.setTimeout(timeout, callback);
    }

    public setNoDelay(noDelay: boolean): any {
        return this.realSocket.setNoDelay(noDelay);
    }

    connect(port: number, host: string, connectionListener?: () => void): void;
    connect(options: net.TcpSocketConnectOpts, connectionListener?: () => void): void;
    public connect(param1: number | net.TcpSocketConnectOpts, param2?: string | (() => void), param3?: () => void): void {
        if (this.connected) {
            throw new Error("realSocket is already connected");
        }

        if (this.connecting) {
            throw new Error("realSocket is already connecting");
        }

        if (typeof param1 === "number" && typeof param2 === "string") {
            this.host = param2;
            this.port = param1;
            if (param3) {
                this.on('connect', param3);
            }
        } else {
            const connectOpts = param1 as net.TcpSocketConnectOpts;
            this.host = connectOpts.host !== undefined ? connectOpts.host : '';
            this.port = connectOpts.port;
            const connectionListener = param2 as (() => void);
            if (param2) {
                this.on('connect', connectionListener);
            }
        }

        console.log(`Use socks proxy ${this.socksHost}:${this.socksPort} connect to ${this.host}:${this.port}`);
        this.connected = false;
        this.connecting = true;

        this.realSocket.connect(this.socksPort, this.socksHost, () => {
            this.connecting = false;
            this.sendAuth();
        });
    }

    public write(str: Uint8Array | string, encoding?: BufferEncoding, cb?: (err?: Error) => void): any {
        //console.log(`proxy write ${this.connected} ${str.length} ${encoding}`);
        if (encoding === undefined) {
            encoding = 'binary';
        }
        if (!this.connected) {
            this.unSent.push([str, encoding, cb]);
            return;
        }

        return this.realSocket.write(str, encoding, cb);
    }

    public pause(): void {
        this.realSocket.pause();
    }

    public resume(): void {
        this.realSocket.resume();
    }

    public address(): any {
        return this.realSocket.address();
    }

    public end(callback?: () => void): any;
    public end(buffer: Uint8Array | string, callback?: () => void): any;
    public end(str: Uint8Array | string, encoding?: BufferEncoding, callback?: () => void): any;
    public end(param1?: Uint8Array | string | any, param2?: BufferEncoding | any, param3?: () => void): any {
        this.writable = false;

        if (!this.connected) {
            return this.realSocket.end();
        }

        if (typeof param1 === "function") {
            return this.realSocket.end(param1);
        } else if (typeof param2 === "function") {
            return this.realSocket.end(param1, param2);
        } else {
            return this.realSocket.end(param1, param2, param3);
        }
    }

    public setEncoding(encoding?: BufferEncoding): void {
        if (this.connected) {
            this.realSocket.setEncoding(encoding);
        } else {
            this.realSocketEncoding = encoding; ///todo
        }
    }

    private receiveSocksConnectData(data: Buffer) {
        if (this.connectStage == 0) {
            this.receiveSocksAuth(data);
            ++this.connectStage;
        } else {
            this.receiveSocksConnect(data);
        }

        if (this.connected && data) {
            this.emit('data', data);
        }
    }

    private receiveSocksAuth(data: Buffer): void {
        let error: Error | null = null;

        if (data.length !== 2) {
            error = new Error('Socks5 authentication failed. Unexpected number of bytes received.');
        } else if (data[0] !== 0x05) {
            error = new Error('Socks5 authentication failed. Unexpected socks version number: ' + data[0] + '.');
        } else if (data[1] !== 0x00) {
            error = new Error('Socks5 authentication failed. Unexpected socks authentication method: ' + data[1] + '.');
        }

        if (error) {
            this.emit('error', error);
            return;
        }

        this.sendConnect();
    }

    private receiveSocksConnect(data: Buffer): void {
        let error: Error | null = null;

        const socksVersion = data[0];
        const responseCode = data[1];
        const reserved = data[2];

        if (socksVersion !== 0x05) {
            error = new Error('Socks version not supported: ' + socksVersion + '.');
        } else if (responseCode !== 0x00) {
            error = new Error('Socks5 connection failed with response code: ' + this.connectErrors[responseCode] + '.');
        } else if (reserved !== 0x00) {
            error = new Error('Socks5 response has invalid reserved field: ' + reserved + '. It must be 0x00.');
        }

        if (error) {
            this.emit('error', error);
            return;
        }

        this.connected = true;

        this.localPort = this.realSocket.localPort;
        this.localAddress = this.realSocket.localAddress;
        this.remotePort = this.realSocket.remotePort;
        this.remoteAddress = this.realSocket.remoteAddress;

        this.setEncoding(this.realSocketEncoding);

        while (this.unSent.length) {
            const [str, encoding, cb] = this.unSent.shift()!;
            this.write(str, encoding, cb);
        }

        while (this.unPiped.length) {
            const [socket, options] = this.unPiped.shift()!;
            this.pipe(socket, options);
        }

        this.emit('connect');
    }

    private sendAuth(): void {
        const buffer = Buffer.alloc(3);
        buffer[0] = 0x05; // Socks5
        buffer[1] = 0x01; // number of authentication methods
        buffer[2] = 0x00; // no authentication

        if (!this.realSocket.write(buffer)) {
            throw new Error("Unable to write to socks5 proxy socket");
        }
    }

    private parseDomainName(host: string, buffer: number[]): void {
        buffer.push(host.length);

        for (let i = 0; i < host.length; i++) {
            const c = host.charCodeAt(i);
            buffer.push(c);
        }
    }

    private parseIPv4(host: string, buffer: number[]): void {
        const parts = host.split('.');

        for (let i = 0; i < parts.length; ++i) {
            const n = parseInt(parts[i], 10);
            buffer.push(n);
        }
    }

    private parseIPv6(host: string, buffer: number[]): void {
        const parts = host.split(':');
        const zeros = [];

        parts[0] = parts[0] || '0000';
        parts[parts.length - 1] = parts[parts.length - 1] || '0000';
        const ind = parts.indexOf('');

        if (ind >= 0) {
            for (let i = 0; i < 8 - parts.length + 1; ++i) {
                zeros.push('0000');
            }

            parts.splice(ind, 1, ...zeros);
        }

        for (let i = 0; i < 8; ++i) {
            const num = parseInt(parts[i], 16);
            buffer.push(num / 256 | 0);
            buffer.push(num % 256);
        }
    }

    private htons(b: number[], i: number, v: number): void {
        b[i] = (0xff & (v >> 8));
        b[i + 1] = (0xff & (v));
    }

    private sendConnect(): void {
        const buffer = [
            0x05, // Socks5
            0x01, // Command code: establish a TCP/IP stream connection
            0x00  // Reserved - myst be 0x00
        ];

        switch (net.isIP(this.host)) {
            default:
            case 0:
                buffer.push(0x03);
                this.parseDomainName(this.host, buffer);
                break;
            case 4:
                buffer.push(0x01);
                this.parseIPv4(this.host, buffer);
                break;
            case 6:
                buffer.push(0x04);
                this.parseIPv6(this.host, buffer);
                break;
        }

        this.htons(buffer, buffer.length, this.port);
        const request = Buffer.from(buffer);

        if (!this.realSocket.write(request)) {
            throw new Error("Unable to write to socks5 proxy socket");
        }
    }

}

