"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyServer = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const crypto = __importStar(require("crypto"));
class ProxyServer {
    traceManager;
    port;
    targetPort;
    server;
    isRunning = false;
    currentPort;
    constructor(traceManager, port = 9090, targetPort = 3000) {
        this.traceManager = traceManager;
        this.port = port;
        this.targetPort = targetPort;
        this.currentPort = port;
    }
    setPorts(inPort, targetPort) {
        this.port = inPort;
        this.currentPort = inPort;
        this.targetPort = targetPort;
    }
    getTargetPort() {
        return this.targetPort;
    }
    async start() {
        let attemptPort = this.port;
        const maxAttempts = 10;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this.listenOnPort(attemptPort);
                this.currentPort = attemptPort;
                this.isRunning = true;
                return this.currentPort;
            }
            catch (err) {
                if (err.code === 'EADDRINUSE' && i < maxAttempts - 1) {
                    attemptPort++;
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`Não foi possível iniciar o proxy após testar ${maxAttempts} portas a partir de ${this.port}.`);
    }
    listenOnPort(port) {
        return new Promise((resolve, reject) => {
            const server = http.createServer((clientReq, clientRes) => this.handleRequest(clientReq, clientRes));
            const onError = (err) => {
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
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    getPort() {
        return this.currentPort;
    }
    getIsRunning() {
        return this.isRunning;
    }
    handleRequest(clientReq, clientRes) {
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
            const chunks = [];
            clientReq.on('data', (c) => chunks.push(c));
            clientReq.on('end', () => {
                try {
                    const span = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    this.traceManager.recordSpan(span);
                    clientRes.writeHead(200, { 'Content-Type': 'application/json' });
                    clientRes.end(JSON.stringify({ ok: true }));
                }
                catch (e) {
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
        const traceparent = clientReq.headers['traceparent'] || '';
        let traceId = '';
        let parentId;
        const w3cRegex = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
        const match = traceparent.match(w3cRegex);
        if (match) {
            traceId = match[1];
            parentId = match[2];
        }
        else {
            traceId = crypto.randomBytes(16).toString('hex');
        }
        const currentSpanId = crypto.randomBytes(8).toString('hex');
        // Mapeamento de Host, Protocolo e Destino
        const hostHeader = clientReq.headers['host'] || 'localhost';
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
            }
            catch { }
        }
        else if (requestUrl.startsWith('http://')) {
            try {
                const parsed = new URL(requestUrl);
                targetPath = parsed.pathname + parsed.search;
                targetHostname = parsed.hostname;
                targetPort = parsed.port ? parseInt(parsed.port, 10) : 80;
            }
            catch { }
        }
        else {
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
                ? parseInt(clientReq.headers['x-target-port'], 10)
                : this.targetPort;
            targetHostname = 'localhost';
            targetPort = backendPort;
        }
        const callerService = parentId ? `API (localhost:${this.targetPort})` : 'Client';
        const targetService = targetHostname === 'localhost' || targetHostname === '127.0.0.1'
            ? `API (localhost:${targetPort})`
            : targetHostname;
        // 5. Bufferização do Body de Envio
        const reqChunks = [];
        clientReq.on('data', (chunk) => reqChunks.push(chunk));
        clientReq.on('end', () => {
            const reqBody = Buffer.concat(reqChunks).toString('utf-8');
            const span = {
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
            const proxyReq = clientModule.request({
                hostname: targetHostname,
                port: targetPort,
                path: targetPath,
                method: clientReq.method,
                headers: headersToForward,
                timeout: 10000
            }, (proxyRes) => {
                const resChunks = [];
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
            });
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
exports.ProxyServer = ProxyServer;
//# sourceMappingURL=proxyServer.js.map