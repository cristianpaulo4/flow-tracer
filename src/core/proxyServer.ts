import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { TraceManager } from './traceManager';
import { TraceSpan } from '../models/transaction';

export class ProxyServer {
    private server?: http.Server;
    private isRunning = false;

    constructor(
        private readonly traceManager: TraceManager,
        private readonly port: number = 9090
    ) { }

    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((clientReq, clientRes) => this.handleRequest(clientReq, clientRes));

            this.server.listen(this.port, () => {
                this.isRunning = true;
                resolve();
            });

            this.server.on('error', (err) => {
                reject(err);
            });
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    public getPort(): number {
        return this.port;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
        const requestUrl = clientReq.url || '/';

        // 1. Endpoint Interno de Ingestão de Spans
        if (requestUrl === '/__flowtracer/span' && clientReq.method === 'POST') {
            const chunks: Buffer[] = [];
            clientReq.on('data', (c) => chunks.push(c));
            clientReq.on('end', () => {
                try {
                    const span: TraceSpan = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    this.traceManager.recordSpan(span);
                    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
                    clientRes.end(JSON.stringify({ ok: true }));
                } catch (e: any) {
                    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        if (!this.traceManager.isCapturing()) {
            this.forwardDirectly(clientReq, clientRes);
            return;
        }

        const startTime = Date.now();

        // 2. Resolução do Contexto Distribuído (W3C Trace Context)
        const traceparent = (clientReq.headers['traceparent'] as string) || '';
        let traceId = '';
        let parentId: string | undefined;

        const w3cRegex = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
        const match = traceparent.match(w3cRegex);

        if (match) {
            traceId = match[1];
            parentId = match[2];
        } else {
            traceId = crypto.randomBytes(16).toString('hex');
        }

        const currentSpanId = crypto.randomBytes(8).toString('hex');

        // Mapeamento de Host, Protocolo e Destino
        const hostHeader = (clientReq.headers['host'] as string) || 'localhost';
        let isHttps = false;
        let targetPath = requestUrl;
        let targetHostname = hostHeader;
        let targetPort = 80;

        if (requestUrl.startsWith('https://')) {
            isHttps = true;
            try {
                const parsed = new URL(requestUrl);
                targetPath = parsed.pathname + parsed.search;
                targetHostname = parsed.hostname;
                targetPort = parsed.port ? parseInt(parsed.port, 10) : 443;
            } catch { }
        } else if (requestUrl.startsWith('http://')) {
            try {
                const parsed = new URL(requestUrl);
                targetPath = parsed.pathname + parsed.search;
                targetHostname = parsed.hostname;
                targetPort = parsed.port ? parseInt(parsed.port, 10) : 80;
            } catch { }
        } else {
            const [hostPart, portPart] = hostHeader.split(':');
            targetHostname = hostPart;
            targetPort = portPart ? parseInt(portPart, 10) : 80;
            if (targetPort === 443) {
                isHttps = true;
            }
        }

        const callerService = parentId ? 'API (localhost:3000)' : 'Client';
        const targetService = targetHostname;

        // 3. Bufferização do Body de Envio
        const reqChunks: Buffer[] = [];
        clientReq.on('data', (chunk) => reqChunks.push(chunk));

        clientReq.on('end', () => {
            const reqBody = Buffer.concat(reqChunks).toString('utf-8');

            const span: TraceSpan = {
                id: currentSpanId,
                traceId,
                parentId,
                callerService,
                targetService,
                request: {
                    method: clientReq.method || 'GET',
                    url: `${isHttps ? 'https' : 'http'}://${targetHostname}${targetPath}`,
                    headers: { ...clientReq.headers },
                    body: reqBody || undefined,
                    timestamp: startTime
                }
            };

            // Injeta o cabeçalho W3C com o span atual e sanitiza headers para evitar compressão ilegível
            const headersToForward = { ...clientReq.headers };
            headersToForward['traceparent'] = `00-${traceId}-${currentSpanId}-01`;
            headersToForward['host'] = targetHostname;
            delete headersToForward['accept-encoding']; // Solicita resposta em texto plano/json descompactado

            const clientModule = isHttps ? https : http;

            const proxyReq = clientModule.request(
                {
                    hostname: targetHostname,
                    port: targetPort,
                    path: targetPath,
                    method: clientReq.method,
                    headers: headersToForward,
                    timeout: 10000
                },
                (proxyRes) => {
                    const resChunks: Buffer[] = [];
                    clientRes.writeHead(proxyRes.statusCode || 500, proxyRes.headers);

                    proxyRes.on('data', (chunk) => {
                        resChunks.push(chunk);
                        clientRes.write(chunk);
                    });

                    proxyRes.on('end', () => {
                        clientRes.end();
                        const durationMs = Date.now() - startTime;
                        const resBody = Buffer.concat(resChunks).toString('utf-8');

                        span.response = {
                            statusCode: proxyRes.statusCode || 500,
                            headers: { ...proxyRes.headers },
                            body: resBody || undefined,
                            durationMs,
                            timestamp: Date.now()
                        };

                        this.traceManager.recordSpan(span);
                    });
                }
            );

            proxyReq.on('error', (err) => {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({ error: `Bad Gateway (FlowTracer Proxy): ${err.message}` }));

                span.response = {
                    statusCode: 502,
                    headers: {},
                    body: `Connection Error: ${err.message}`,
                    durationMs: Date.now() - startTime,
                    timestamp: Date.now()
                };
                this.traceManager.recordSpan(span);
            });

            if (reqChunks.length > 0) {
                proxyReq.write(Buffer.concat(reqChunks));
            }
            proxyReq.end();
        });
    }

    private forwardDirectly(req: http.IncomingMessage, res: http.ServerResponse): void {
        const hostHeader = (req.headers['host'] as string) || 'localhost';
        const [targetHostname, targetPortStr] = hostHeader.split(':');
        const targetPort = targetPortStr ? parseInt(targetPortStr, 10) : 80;

        const proxyReq = http.request(
            {
                hostname: targetHostname,
                port: targetPort,
                path: req.url,
                method: req.method,
                headers: req.headers
            },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
                proxyRes.pipe(res);
            }
        );

        proxyReq.on('error', (err) => {
            res.writeHead(502);
            res.end(`Proxy Error: ${err.message}`);
        });

        req.pipe(proxyReq);
    }
}
