import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { TraceManager } from './traceManager';
import { TraceSpan } from '../models/transaction';

export class ProxyServer {
    private server?: http.Server;
    private isRunning = false;
    private currentPort: number;

    constructor(
        private readonly traceManager: TraceManager,
        private port: number = 9090,
        private targetPort: number = 3000
    ) {
        this.currentPort = port;
    }

    public setPorts(inPort: number, targetPort: number): void {
        this.port = inPort;
        this.currentPort = inPort;
        this.targetPort = targetPort;
    }

    public getTargetPort(): number {
        return this.targetPort;
    }

    public async start(): Promise<number> {
        let attemptPort = this.port;
        const maxAttempts = 10;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this.listenOnPort(attemptPort);
                this.currentPort = attemptPort;
                this.isRunning = true;
                return this.currentPort;
            } catch (err: any) {
                if (err.code === 'EADDRINUSE' && i < maxAttempts - 1) {
                    attemptPort++;
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`Não foi possível iniciar o proxy após testar ${maxAttempts} portas a partir de ${this.port}.`);
    }

    private listenOnPort(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((clientReq, clientRes) => this.handleRequest(clientReq, clientRes));

            const onError = (err: any) => {
                server.removeAllListeners();
                reject(err);
            };

            server.once('error', onError);

            server.listen(port, () => {
                server.removeListener('error', onError);
                this.server = server;
                server.on('error', (err) => {
                    console.error('FlowTracer Proxy Runtime Error:', err);
                });
                resolve();
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
        return this.currentPort;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    private handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
        const requestUrl = clientReq.url || '/';

        // 1. Endpoint Interno de Ping / Health Check
        if (requestUrl === '/__flowtracer/ping' || requestUrl === '/__flowtracer/health') {
            clientRes.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            clientRes.end(JSON.stringify({ status: 'ok', app: 'flowtracer', inPort: this.currentPort, targetPort: this.targetPort }));
            return;
        }

        // 2. Endpoint Interno de Ingestão de Spans
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

        // 3. Suporte Completo a CORS Preflight (Essencial para requisições disparadas pelo Swagger no navegador)
        if (clientReq.method === 'OPTIONS') {
            clientRes.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400'
            });
            clientRes.end();
            return;
        }

        const startTime = Date.now();

        // 4. Resolução do Contexto Distribuído (W3C Trace Context)
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

        // 5. Modo Gateway Reverso Inteligente:
        // Se a chamada veio direto para a porta do proxy (ex: Swagger ou Postman chamando http://localhost:9090/api/...)
        const isCallingProxyDirectly = (targetHostname === 'localhost' || targetHostname === '127.0.0.1') && targetPort === this.currentPort;
        if (isCallingProxyDirectly) {
            // Redireciona para o backend local (porta de destino configurada ou especificada no header x-target-port)
            const backendPort = clientReq.headers['x-target-port']
                ? parseInt(clientReq.headers['x-target-port'] as string, 10)
                : this.targetPort;
            targetHostname = 'localhost';
            targetPort = backendPort;
        }

        const callerService = parentId ? `API (localhost:${this.targetPort})` : 'Client';
        const targetService = targetHostname === 'localhost' || targetHostname === '127.0.0.1'
            ? `API (localhost:${targetPort})`
            : targetHostname;

        // 5. Bufferização do Body de Envio
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
                    url: `${isHttps ? 'https' : 'http'}://${targetHostname}:${targetPort}${targetPath}`,
                    headers: { ...clientReq.headers },
                    body: reqBody || undefined,
                    timestamp: startTime
                }
            };

            // Injeta o cabeçalho W3C com o span atual e sanitiza headers para evitar compressão ilegível
            const headersToForward = { ...clientReq.headers };
            headersToForward['traceparent'] = `00-${traceId}-${currentSpanId}-01`;
            headersToForward['x-flowtracer-port'] = this.currentPort.toString();
            headersToForward['host'] = `${targetHostname}:${targetPort}`;
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
                    // Adiciona CORS nos headers de resposta para o Swagger funcionar perfeitamente no navegador
                    const resHeaders = { ...proxyRes.headers };
                    resHeaders['access-control-allow-origin'] = '*';
                    resHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
                    resHeaders['access-control-allow-headers'] = '*';

                    clientRes.writeHead(proxyRes.statusCode || 500, resHeaders);

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
}
