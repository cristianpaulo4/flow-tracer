import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { URL } from 'url';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const PROXY_URL = process.env.HTTP_PROXY || 'http://localhost:9090';

/**
 * Notifica o FlowTracer sobre um span (para registrar chamadas na timeline/diagrama).
 */
function sendSpanToFlowTracer(span: any): void {
    try {
        const proxy = new URL(PROXY_URL);
        const data = JSON.stringify(span);
        const req = http.request({
            hostname: proxy.hostname,
            port: proxy.port ? parseInt(proxy.port, 10) : 9090,
            path: '/__flowtracer/span',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        });
        req.on('error', () => {
            // Silencia se o proxy não estiver aberto no momento
        });
        req.write(data);
        req.end();
    } catch { }
}

/**
 * Dispara requisições HTTP/HTTPS downstream,
 * tenta via proxy do FlowTracer e faz fallback transparente para chamada direta HTTPS se necessário.
 */
async function fetchWithTracing(targetUrl: string, parentTraceContext: string): Promise<{ status: number; data: any; durationMs: number }> {
    const startTime = Date.now();
    const parsedTarget = new URL(targetUrl);

    let traceId = '';
    let parentSpanId: string | undefined;

    const match = parentTraceContext.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
    if (match) {
        traceId = match[1];
        parentSpanId = match[2];
    } else {
        traceId = crypto.randomBytes(16).toString('hex');
    }

    const currentSpanId = crypto.randomBytes(8).toString('hex');
    const outgoingTraceparent = `00-${traceId}-${currentSpanId}-01`;

    const headers: Record<string, string> = {
        'User-Agent': 'LocationInsightsService/1.0',
        'Accept': 'application/json',
        'traceparent': outgoingTraceparent
    };

    try {
        // Tenta enviar via Proxy HTTP do FlowTracer
        const proxy = new URL(PROXY_URL);
        const proxyRes = await new Promise<{ status: number; data: any; durationMs: number }>((resolve, reject) => {
            const req = http.request({
                hostname: proxy.hostname,
                port: proxy.port ? parseInt(proxy.port, 10) : 9090,
                path: targetUrl,
                method: 'GET',
                headers: {
                    ...headers,
                    'Host': parsedTarget.host
                },
                timeout: 5000
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const rawBody = Buffer.concat(chunks).toString('utf-8');
                    let parsedJson: any = null;
                    try { parsedJson = JSON.parse(rawBody); } catch { parsedJson = rawBody; }

                    resolve({
                        status: res.statusCode || 500,
                        data: parsedJson,
                        durationMs: Date.now() - startTime
                    });
                });
            });

            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('Proxy timeout')));
            req.end();
        });

        // Se o proxy retornou com sucesso (não 502/504)
        if (proxyRes.status >= 200 && proxyRes.status < 400) {
            return proxyRes;
        }

        console.warn(`[Proxy Fallback] Proxy retornou status ${proxyRes.status} para ${targetUrl}. Chamando direto via HTTPS...`);
    } catch (proxyErr: any) {
        // Proxy indisponível no momento
    }

    // Fallback: Chamada Direta via HTTPS nativo
    return makeDirectRequest(parsedTarget, headers, startTime, traceId, parentSpanId, currentSpanId);
}

function makeDirectRequest(parsedTarget: URL, headers: Record<string, string>, startTime: number, traceId: string, parentSpanId?: string, spanId?: string): Promise<{ status: number; data: any; durationMs: number }> {
    return new Promise((resolve, reject) => {
        const client = parsedTarget.protocol === 'https:' ? https : http;
        const req = client.request({
            hostname: parsedTarget.hostname,
            port: parsedTarget.port ? parseInt(parsedTarget.port, 10) : (parsedTarget.protocol === 'https:' ? 443 : 80),
            path: parsedTarget.pathname + parsedTarget.search,
            method: 'GET',
            headers: {
                ...headers,
                'Host': parsedTarget.host
            },
            timeout: 8000
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                let parsed: any;
                try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                const durationMs = Date.now() - startTime;

                // Registra o nó no FlowTracer com o traceId pai
                if (spanId) {
                    sendSpanToFlowTracer({
                        id: spanId,
                        traceId,
                        parentId: parentSpanId,
                        callerService: `localhost:${PORT}`,
                        targetService: parsedTarget.host,
                        request: {
                            method: 'GET',
                            url: parsedTarget.href,
                            headers,
                            timestamp: startTime
                        },
                        response: {
                            statusCode: res.statusCode || 200,
                            headers: res.headers,
                            body: raw,
                            durationMs,
                            timestamp: Date.now()
                        }
                    });
                }

                resolve({
                    status: res.statusCode || 500,
                    data: parsed,
                    durationMs
                });
            });
        });

        req.on('error', (err) => {
            console.error(`Erro ao consultar diretamente ${parsedTarget.href}:`, err.message);
            reject(err);
        });

        req.end();
    });
}

// -------------------------------------------------------------
// Servidor HTTP Principal
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

    // Endpoint: /api/cep/:cep
    const cepMatch = urlObj.pathname.match(/^\/api\/cep\/([0-9]{5}-?[0-9]{3})$/);
    if (!cepMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Endpoint não encontrado.',
            usage: `GET http://localhost:${PORT}/api/cep/01001000`
        }));
        return;
    }

    const cep = cepMatch[1].replace('-', '');

    // 1. Contexto Pai Raiz
    let traceId = '';
    let parentSpanId: string | undefined;
    const incomingTrace = (req.headers['traceparent'] as string) || '';
    const w3cRegex = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
    const match = incomingTrace.match(w3cRegex);

    if (match) {
        traceId = match[1];
        parentSpanId = match[2];
    } else {
        traceId = crypto.randomBytes(16).toString('hex');
    }

    const rootSpanId = parentSpanId || crypto.randomBytes(8).toString('hex');
    const parentTraceContext = `00-${traceId}-${rootSpanId}-01`;

    // 2. Registra o Span Pai no FlowTracer (sem parentId)
    sendSpanToFlowTracer({
        id: rootSpanId,
        traceId,
        callerService: 'Client',
        targetService: `localhost:${PORT}`,
        request: {
            method: req.method || 'GET',
            url: `http://localhost:${PORT}${req.url}`,
            headers: req.headers,
            timestamp: startTime
        }
    });

    console.log(`\n==================================================`);
    console.log(`[FlowTracer] 🌟 Chamada Pai Iniciada: GET http://localhost:${PORT}${req.url}`);
    console.log(`[Trace ID] ${traceId} (Root Span: ${rootSpanId})`);

    try {
        const failTarget = urlObj.searchParams.get('fail');

        // Chamada 1: ViaCEP
        console.log(`  ➔ [1/5] viacep.com.br`);
        if (failTarget === 'viacep') {
            sendSpanToFlowTracer({
                id: crypto.randomBytes(8).toString('hex'),
                traceId,
                parentId: rootSpanId,
                callerService: `localhost:${PORT}`,
                targetService: 'viacep.com.br',
                request: { method: 'GET', url: `https://viacep.com.br/ws/${cep}/json/`, headers: {}, timestamp: Date.now() },
                response: { statusCode: 502, headers: {}, body: JSON.stringify({ error: 'Bad Gateway (Simulado)' }), durationMs: 40, timestamp: Date.now() }
            });
            throw new Error('Falha no serviço viacep.com.br (502 Bad Gateway simulado)');
        }

        const viaCepRes = await fetchWithTracing(`https://viacep.com.br/ws/${cep}/json/`, parentTraceContext);

        if (viaCepRes.status !== 200 || !viaCepRes.data || viaCepRes.data.erro === true || viaCepRes.data.erro === 'true') {
            console.warn(`[ViaCEP] CEP não encontrado ou status ${viaCepRes.status}:`, viaCepRes.data);
            const errPayload = { error: `CEP ${cep} não localizado na base do ViaCEP.` };
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errPayload));

            sendSpanToFlowTracer({
                id: rootSpanId,
                traceId,
                callerService: 'Client',
                targetService: `localhost:${PORT}`,
                request: { method: 'GET', url: `http://localhost:${PORT}${req.url}`, headers: req.headers, timestamp: startTime },
                response: { statusCode: 404, headers: {}, body: JSON.stringify(errPayload), durationMs: Date.now() - startTime, timestamp: Date.now() }
            });
            return;
        }

        const endereco = viaCepRes.data;
        const cidade = endereco.localidade;
        const uf = endereco.uf;
        const ibgeId = endereco.ibge;
        const ddd = endereco.ddd;

        // Chamadas 2 e 3 em Paralelo: IBGE + BrasilAPI
        console.log(`  ➔ [2/5] servicodados.ibge.gov.br`);
        console.log(`  ➔ [3/5] brasilapi.com.br`);

        if (failTarget === 'ibge') {
            sendSpanToFlowTracer({
                id: crypto.randomBytes(8).toString('hex'),
                traceId,
                parentId: rootSpanId,
                callerService: `localhost:${PORT}`,
                targetService: 'servicodados.ibge.gov.br',
                request: { method: 'GET', url: `https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${ibgeId}`, headers: {}, timestamp: Date.now() },
                response: { statusCode: 503, headers: {}, body: JSON.stringify({ error: 'Service Unavailable (Simulado)' }), durationMs: 85, timestamp: Date.now() }
            });
            throw new Error('Falha no serviço IBGE Localidades (503 Service Unavailable simulado)');
        }

        const [ibgeRes, dddRes] = await Promise.all([
            fetchWithTracing(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${ibgeId}`, parentTraceContext),
            fetchWithTracing(`https://brasilapi.com.br/api/ddd/v1/${ddd}`, parentTraceContext)
        ]);

        // Chamada 4: Geocoding Open-Meteo
        console.log(`  ➔ [4/5] geocoding-api.open-meteo.com`);
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt&format=json`;
        const geoRes = await fetchWithTracing(geoUrl, parentTraceContext);

        let latitude = -23.5475;
        let longitude = -46.63611;
        let geoInfo: any = null;

        if (geoRes.data && geoRes.data.results && geoRes.data.results.length > 0) {
            const topGeo = geoRes.data.results[0];
            latitude = topGeo.latitude;
            longitude = topGeo.longitude;
            geoInfo = {
                latitude: topGeo.latitude,
                longitude: topGeo.longitude,
                elevacao: topGeo.elevation,
                timezone: topGeo.timezone
            };
        }

        // Chamada 5: Clima Open-Meteo
        console.log(`  ➔ [5/5] api.open-meteo.com`);
        if (failTarget === 'weather') {
            sendSpanToFlowTracer({
                id: crypto.randomBytes(8).toString('hex'),
                traceId,
                parentId: rootSpanId,
                callerService: `localhost:${PORT}`,
                targetService: 'api.open-meteo.com',
                request: { method: 'GET', url: 'https://api.open-meteo.com/v1/forecast?...', headers: {}, timestamp: Date.now() },
                response: { statusCode: 500, headers: {}, body: JSON.stringify({ error: 'Internal Server Error no Clima' }), durationMs: 120, timestamp: Date.now() }
            });
            throw new Error('Falha no serviço meteorológico api.open-meteo.com (500 Internal Error simulado)');
        }

        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m`;
        const weatherRes = await fetchWithTracing(weatherUrl, parentTraceContext);

        // Consolidação da Resposta
        const payloadConsolidado = {
            metadata: {
                cepConsultado: cep,
                timestamp: new Date().toISOString(),
                totalServicosConsultados: 5
            },
            localizacao: {
                logradouro: endereco.logradouro,
                bairro: endereco.bairro,
                cidade: endereco.localidade,
                estado: endereco.uf,
                codigoIbge: endereco.ibge,
                ddd: endereco.ddd
            },
            detalhesRegiaoIbge: {
                municipio: ibgeRes.data?.nome,
                microrregiao: ibgeRes.data?.microrregiao?.nome,
                mesorregiao: ibgeRes.data?.microrregiao?.mesorregiao?.nome,
                regiao: ibgeRes.data?.microrregiao?.mesorregiao?.UF?.regiao?.nome
            },
            telecomunicacoes: {
                ddd,
                estado: dddRes.data?.state,
                cidadesAtendidasTotal: dddRes.data?.cities?.length || 0,
                exemploCidades: (dddRes.data?.cities || []).slice(0, 5)
            },
            coordenadas: geoInfo,
            climaTempoReal: {
                temperaturaAtual: `${weatherRes.data?.current?.temperature_2m ?? '--'}°C`,
                sensacaoTermica: `${weatherRes.data?.current?.apparent_temperature ?? '--'}°C`,
                umidadeRelativa: `${weatherRes.data?.current?.relative_humidity_2m ?? '--'}%`,
                velocidadeVento: `${weatherRes.data?.current?.wind_speed_10m ?? '--'} km/h`,
                precipitacao: `${weatherRes.data?.current?.precipitation ?? '0'} mm`
            }
        };

        const totalDurationMs = Date.now() - startTime;
        const jsonResponse = JSON.stringify(payloadConsolidado, null, 2);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(jsonResponse);

        // 3. Atualiza o Span Pai com a resposta consolidada
        sendSpanToFlowTracer({
            id: rootSpanId,
            traceId,
            callerService: 'Client',
            targetService: `localhost:${PORT}`,
            request: {
                method: 'GET',
                url: `http://localhost:${PORT}${req.url}`,
                headers: req.headers,
                timestamp: startTime
            },
            response: {
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
                body: jsonResponse,
                durationMs: totalDurationMs,
                timestamp: Date.now()
            }
        });

        console.log(`[FlowTracer] ✅ Fluxo concluído com sucesso em ${totalDurationMs}ms.`);

    } catch (err: any) {
        console.error(`[Erro no fluxo]`, err);
        const errJson = JSON.stringify({ error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(errJson);

        sendSpanToFlowTracer({
            id: rootSpanId,
            traceId,
            callerService: 'Client',
            targetService: `localhost:${PORT}`,
            request: { method: 'GET', url: `http://localhost:${PORT}${req.url}`, headers: req.headers, timestamp: startTime },
            response: { statusCode: 500, headers: {}, body: errJson, durationMs: Date.now() - startTime, timestamp: Date.now() }
        });
    }
});

server.listen(PORT, () => {
    console.log(`\n=======================================================`);
    console.log(`🚀 Location Insights API rodando em http://localhost:${PORT}`);
    console.log(`📡 Conectado ao FlowTracer em: ${PROXY_URL}`);
    console.log(`👉 Teste: http://localhost:${PORT}/api/cep/01001000`);
    console.log(`=======================================================\n`);
});
