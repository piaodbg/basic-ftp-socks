import { EventEmitter } from "events"
import { describeAddress, describeTLS, ipIsPrivateV4Address } from "./netUtils"
import { Writable, Readable, pipeline, PassThrough, TransformOptions } from "stream"
import { TLSSocket, connect as connectTLS } from "tls"
import { FTPContext, FTPResponse, TaskResolver } from "./FtpContext"
import { ProgressTracker, ProgressType } from "./ProgressTracker"
import { positiveIntermediate, positiveCompletion } from "./parseControlResponse"
import { AccessOptions, Client } from "./Client"
import { Socket } from "net"

export type UploadCommand = "STOR" | "APPE"

/**
 * Prepare a data socket using passive mode over IPv6.
 */
export async function enterPassiveModeIPv6(ftp: FTPContext): Promise<FTPResponse> {
    const res = await ftp.request("EPSV")
    const port = parseEpsvResponse(res.message)
    if (!port) {
        throw new Error("Can't parse EPSV response: " + res.message)
    }
    const controlHost = ftp.socket.remoteAddress
    if (controlHost === undefined) {
        throw new Error("Control socket is disconnected, can't get remote address.")
    }
    await connectForPassiveTransfer(controlHost, port, ftp)
    return res
}

/**
 * Parse an EPSV response. Returns only the port as in EPSV the host of the control connection is used.
 */
export function parseEpsvResponse(message: string): number {
    // Get port from EPSV response, e.g. "229 Entering Extended Passive Mode (|||6446|)"
    // Some FTP Servers such as the one on IBM i (OS/400) use ! instead of | in their EPSV response.
    const groups = message.match(/[|!]{3}(.+)[|!]/)
    if (groups === null || groups[1] === undefined) {
        throw new Error(`Can't parse response to 'EPSV': ${message}`)
    }
    const port = parseInt(groups[1], 10)
    if (Number.isNaN(port)) {
        throw new Error(`Can't parse response to 'EPSV', port is not a number: ${message}`)
    }
    return port
}

/**
 * Prepare a data socket using passive mode over IPv4.
 */
export async function enterPassiveModeIPv4(ftp: FTPContext): Promise<FTPResponse> {
    const res = await ftp.request("PASV")
    const target = parsePasvResponse(res.message)
    if (!target) {
        throw new Error("Can't parse PASV response: " + res.message)
    }
    // If the host in the PASV response has a local address while the control connection hasn't,
    // we assume a NAT issue and use the IP of the control connection as the target for the data connection.
    // We can't always perform this replacement because it's possible (although unlikely) that the FTP server
    // indeed uses a different host for data connections.
    const controlHost = ftp.socket.remoteAddress
    if (ipIsPrivateV4Address(target.host) && controlHost && !ipIsPrivateV4Address(controlHost)) {
        target.host = controlHost
    }
    await connectForPassiveTransfer(target.host, target.port, ftp)
    return res
}

/**
 * Parse a PASV response.
 */
export function parsePasvResponse(message: string): { host: string, port: number } {
    // Get host and port from PASV response, e.g. "227 Entering Passive Mode (192,168,1,100,10,229)"
    const groups = message.match(/([-\d]+,[-\d]+,[-\d]+,[-\d]+),([-\d]+),([-\d]+)/)
    if (groups === null || groups.length !== 4) {
        throw new Error(`Can't parse response to 'PASV': ${message}`)
    }
    return {
        host: groups[1].replace(/,/g, "."),
        port: (parseInt(groups[2], 10) & 255) * 256 + (parseInt(groups[3], 10) & 255)
    }
}

export function connectForPassiveTransfer(host: string, port: number, ftp: FTPContext): Promise<void> {
    return new Promise((resolve, reject) => {
        let socket = ftp._newSocket()
        const handleConnErr = function(err: Error) {
            err.message = "Can't open data connection in passive mode: " + err.message
            reject(err)
        }
        const handleTimeout = function() {
            socket.destroy()
            reject(new Error(`Timeout when trying to open data connection to ${host}:${port}`))
        }
        socket.setTimeout(ftp.timeout)
        socket.on("error", handleConnErr)
        socket.on("timeout", handleTimeout)
        socket.connect({ port, host, family: ftp.ipFamily}, () => {
            if (ftp.socket instanceof TLSSocket) {
                socket = connectTLS(Object.assign({}, ftp.tlsOptions, {
                    socket,
                    // Reuse the TLS session negotiated earlier when the control connection
                    // was upgraded. Servers expect this because it provides additional
                    // security: If a completely new session would be negotiated, a hacker
                    // could guess the port and connect to the new data connection before we do
                    // by just starting his/her own TLS session.
                    session: ftp.socket.getSession()
                }))
                // It's the responsibility of the transfer task to wait until the
                // TLS socket issued the event 'secureConnect'. We can't do this
                // here because some servers will start upgrading after the
                // specific transfer request has been made. List and download don't
                // have to wait for this event because the server sends whenever it
                // is ready. But for upload this has to be taken into account,
                // see the details in the upload() function below.
            }
            // Let the FTPContext listen to errors from now on, remove local handler.
            socket.removeListener("error", handleConnErr)
            socket.removeListener("timeout", handleTimeout)
            ftp.dataSocket = socket
            resolve()
        })
    })
}

/**
 * Helps resolving/rejecting transfers.
 *
 * This is used internally for all FTP transfers. For example when downloading, the server might confirm
 * with "226 Transfer complete" when in fact the download on the data connection has not finished
 * yet. With all transfers we make sure that a) the result arrived and b) has been confirmed by
 * e.g. the control connection. We just don't know in which order this will happen.
 */
class TransferResolver {

    protected response: FTPResponse | undefined = undefined
    protected dataTransferDone = false

    /**
     * Instantiate a TransferResolver
     */
    constructor(readonly ftp: FTPContext, readonly progress: ProgressTracker) {}

    /**
     * Mark the beginning of a transfer.
     *
     * @param name - Name of the transfer, usually the filename.
     * @param type - Type of transfer, usually "upload" or "download".
     */
    onDataStart(name: string, type: ProgressType) {
        // Let the data socket be in charge of tracking timeouts during transfer.
        // The control socket sits idle during this time anyway and might provoke
        // a timeout unnecessarily. The control connection will take care
        // of timeouts again once data transfer is complete or failed.
        if (this.ftp.dataSocket === undefined) {
            throw new Error("Data transfer should start but there is no data connection.")
        }
        this.ftp.socket.setTimeout(0)
        this.ftp.dataSocket.setTimeout(this.ftp.timeout)
        this.progress.start(this.ftp.dataSocket, name, type)
    }

    /**
     * The data connection has finished the transfer.
     */
    onDataDone(task: TaskResolver) {
        this.progress.updateAndStop()
        // Hand-over timeout tracking back to the control connection. It's possible that
        // we don't receive the response over the control connection that the transfer is
        // done. In this case, we want to correctly associate the resulting timeout with
        // the control connection.
        this.ftp.socket.setTimeout(this.ftp.timeout)
        if (this.ftp.dataSocket) {
            this.ftp.dataSocket.setTimeout(0)
        }
        this.dataTransferDone = true
        this.tryResolve(task)
    }

    /**
     * The control connection reports the transfer as finished.
     */
    onControlDone(task: TaskResolver, response: FTPResponse) {
        this.response = response
        this.tryResolve(task)
    }

    /**
     * An error has been reported and the task should be rejected.
     */
    onError(task: TaskResolver, err: Error) {
        this.progress.updateAndStop()
        this.ftp.socket.setTimeout(this.ftp.timeout)
        this.ftp.dataSocket = undefined
        task.reject(err)
    }

    /**
     * Control connection sent an unexpected request requiring a response from our part. We
     * can't provide that (because unknown) and have to close the contrext with an error because
     * the FTP server is now caught up in a state we can't resolve.
     */
    onUnexpectedRequest(response: FTPResponse) {
        const err = new Error(`Unexpected FTP response is requesting an answer: ${response.message}`)
        this.ftp.closeWithError(err)
    }

    protected tryResolve(task: TaskResolver) {
        // To resolve, we need both control and data connection to report that the transfer is done.
        const canResolve = this.dataTransferDone && this.response !== undefined
        if (canResolve) {
            this.ftp.dataSocket = undefined
            task.resolve(this.response)
        }
    }
}

export interface TransferConfig {
    command: string
    remotePath: string
    type: ProgressType
    ftp: FTPContext
    tracker: ProgressTracker
    accessOptions?: AccessOptions
}

interface UploadConfigs {
    config: TransferConfig
    source: Readable
    dataSocket: Socket
    remoteSizeAlright: boolean
}

export function uploadFrom(source: Readable, config: TransferConfig): Promise<FTPResponse> {
    const resolver = new TransferResolver(config.ftp, config.tracker)
    const fullCommand = `${config.command} ${config.remotePath}`
    return config.ftp.handle(fullCommand, (res, task) => {
        if (res instanceof Error) {
            resolver.onError(task, res)
        }
        else if (res.code === 150 || res.code === 125) { // Ready to upload
            const dataSocket = config.ftp.dataSocket
            if (!dataSocket) {
                resolver.onError(task, new Error("Upload should begin but no data connection is available."))
                return
            }
            // If we are using TLS, we have to wait until the dataSocket issued
            // 'secureConnect'. If this hasn't happened yet, getCipher() returns undefined.
            const canUpload = "getCipher" in dataSocket ? dataSocket.getCipher() !== undefined : true
            onConditionOrEvent(canUpload, dataSocket, "secureConnect", () => {
                config.ftp.log(`Uploading to ${describeAddress(dataSocket)} (${describeTLS(dataSocket)})`)
                resolver.onDataStart(config.remotePath, config.type)

                // During the process of client->socksProxy->server, the pipeline can only confirm the completion of
                // data transmission from client->socksProxy. However, it cannot confirm the completion of data transmission socksProxy->server.
                // If the client call socket.end() before the data transmission socksProxy->server is completed,
                // it will cause the socksProxy to disconnect prematurely, preventing the server from receiving the complete data.
                if (config.accessOptions?.useSocksProxy) {
                    const uploadConfigs : UploadConfigs = {
                        config: config,
                        source: source,
                        dataSocket: dataSocket,
                        remoteSizeAlright: false
                    }
                    uploadBySocksProxy(uploadConfigs, err => {
                        if (err) {
                            // When the data transfer socksProxy->server is complete, the dataSocket may receive 'ECONNRESET' error.
                            // Due to the avoidance of prematurely calling socket.end() to ensure complete data transmission, the optimal timing for ending the connection was missed.
                            // In this case, if checking indicates that the data has been fully sent, it can be considered a successful transfer;
                            // otherwise, it is considered a failed transfer.
                            if ('code' in err && err.code === "ECONNRESET" && uploadConfigs.remoteSizeAlright) {
                                config.ftp.log(`Pass the proxy dataSocket err: ${err.code}`)
                                resolver.onDataDone(task)
                            } else {
                                resolver.onError(task, err)
                            }
                        } else {
                            resolver.onDataDone(task)
                        }
                    })
                    return
                }

                pipeline(source, dataSocket, err => {
                    if (err) {
                        resolver.onError(task, err)
                    } else {
                        resolver.onDataDone(task)
                    }
                })
            })
        }
        else if (positiveCompletion(res.code)) { // Transfer complete
            resolver.onControlDone(task, res)
        }
        else if (positiveIntermediate(res.code)) {
            resolver.onUnexpectedRequest(res)
        }
        // Ignore all other positive preliminary response codes (< 200)
    })
}

function uploadBySocksProxy(uploadConfigs: UploadConfigs, cb: (err: any) => void): void  {
    uploadConfigs.remoteSizeAlright = false
    async function checkRemoteSize(translength: number) {
        const client = new Client()
        client.ftp.verbosePrefix = '[UploadBySocksProxy Checksize]'
        client.ftp.verbose = uploadConfigs.config.ftp.verbose
        let serverFileSize = 0
        try {
            uploadConfigs.config.ftp.log(`[upload by socks proxy] Connect server for checksize`)
            await client.access(uploadConfigs.config.accessOptions)
            serverFileSize = await client.size(uploadConfigs.config.remotePath)
            console.log(`[upload by socks proxy] checksize: ${uploadConfigs.config.remotePath} : ${serverFileSize}`) 
            client.close()
        } catch (err) {
            console.error(`[upload by socks proxy] checksize FTP error: ${err}`)
            client.close()
        }
        if (serverFileSize === translength) {
            console.log(`[upload by socks proxy] Server file size correct, upload complete!`)
            uploadConfigs.remoteSizeAlright = true
            uploadConfigs.dataSocket?.end()
        } else {
            console.log(`[upload by socks proxy] Warring! The file may not have been transferred complete yet!`)
            uploadConfigs.dataSocket?.end()
        }
    }
    class CustomPassThrough extends PassThrough {
        private translength:number
        constructor(opts?: TransformOptions) {
            super(opts)
            this.translength = 0
        }
        write(chunk: any, encoding?: BufferEncoding, cb?: (error: Error | null | undefined) => void): boolean
        write(chunk: any, cb?: (error: Error | null | undefined) => void): boolean
        write(chunk: any, encoding?: BufferEncoding | undefined | ((error: Error | null | undefined) => void), cb?: ((error: Error | null | undefined) => void) | undefined): boolean {
            this.translength += chunk.length
            return super.write(chunk, encoding as BufferEncoding, cb)
        }

        end(cb?: () => void): this
        end(chunk: any, cb?: () => void): this
        end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this
        end(chunk?: any, encoding?: BufferEncoding | (() => void), cb?: () => void): any {
            console.log(`[upload by socks proxy] The data has been passed to the proxy service, size: ${this.translength}`)
            console.log(`[upload by socks proxy] It is unknown whether the proxy server has sent all the data and cannot close the connection immediately, so the detection process begins ...`)
            checkRemoteSize(this.translength)
        }
    }
    const passThrough = new CustomPassThrough()
    pipeline(uploadConfigs.source, passThrough, uploadConfigs.dataSocket, cb)
}

export function downloadTo(destination: Writable, config: TransferConfig): Promise<FTPResponse> {
    if (!config.ftp.dataSocket) {
        throw new Error("Download will be initiated but no data connection is available.")
    }
    const resolver = new TransferResolver(config.ftp, config.tracker)
    return config.ftp.handle(config.command, (res, task) => {
        if (res instanceof Error) {
            resolver.onError(task, res)
        }
        else if (res.code === 150 || res.code === 125) { // Ready to download
            const dataSocket = config.ftp.dataSocket
            if (!dataSocket) {
                resolver.onError(task, new Error("Download should begin but no data connection is available."))
                return
            }
            config.ftp.log(`Downloading from ${describeAddress(dataSocket)} (${describeTLS(dataSocket)})`)
            resolver.onDataStart(config.remotePath, config.type)
            pipeline(dataSocket, destination, err => {
                if (err) {
                    resolver.onError(task, err)
                } else {
                    resolver.onDataDone(task)
                }
            })
        }
        else if (res.code === 350) { // Restarting at startAt.
            config.ftp.send("RETR " + config.remotePath)
        }
        else if (positiveCompletion(res.code)) { // Transfer complete
            resolver.onControlDone(task, res)
        }
        else if (positiveIntermediate(res.code)) {
            resolver.onUnexpectedRequest(res)
        }
        // Ignore all other positive preliminary response codes (< 200)
    })
}

/**
 * Calls a function immediately if a condition is met or subscribes to an event and calls
 * it once the event is emitted.
 *
 * @param condition  The condition to test.
 * @param emitter  The emitter to use if the condition is not met.
 * @param eventName  The event to subscribe to if the condition is not met.
 * @param action  The function to call.
 */
function onConditionOrEvent(condition: boolean, emitter: EventEmitter, eventName: string, action: () => void) {
    if (condition === true) {
        action()
    }
    else {
        emitter.once(eventName, () => action())
    }
}
