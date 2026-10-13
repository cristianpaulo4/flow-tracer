import { HttpExchange } from '../models/transaction';

export class CurlGenerator {
    /**
     * Gera o comando curl exato a partir de uma requisição HTTP interceptada.
     */
    public static generate(request: HttpExchange): string {
        const parts: string[] = ['curl'];

        const method = (request.method || 'GET').toUpperCase();
        parts.push(`-X ${method}`);
        parts.push(`"${request.url}"`);

        if (request.headers) {
            for (const [key, value] of Object.entries(request.headers)) {
                if (!value || key.toLowerCase() === 'content-length' || key.toLowerCase() === 'host') {
                    continue;
                }
                const headerVal = Array.isArray(value) ? value.join(', ') : String(value);
                const sanitized = headerVal.replace(/"/g, '\\"');
                parts.push(`-H "${key}: ${sanitized}"`);
            }
        }

        if (request.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            const sanitizedBody = request.body.replace(/'/g, `'\\''`);
            parts.push(`--data '${sanitizedBody}'`);
        }

        return parts.join(' \\\n  ');
    }
}
