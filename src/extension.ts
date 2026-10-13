import * as vscode from 'vscode';
import { TraceManager } from './core/traceManager';
import { ProxyServer } from './core/proxyServer';
import { TraceTreeDataProvider } from './providers/traceTreeDataProvider';
import { TraceWebviewPanel } from './webview/traceWebviewPanel';
import { TraceTransaction } from './models/transaction';

let proxyServer: ProxyServer | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const traceManager = new TraceManager();

    // 1. Obter porta das configurações do VS Code
    const config = vscode.workspace.getConfiguration('flowTracer');
    const proxyPort = config.get<number>('proxyPort', 9090);

    // 2. Inicializar o Proxy Server Local
    proxyServer = new ProxyServer(traceManager, proxyPort);

    try {
        await proxyServer.start();
        vscode.window.showInformationMessage(`FlowTracer: Proxy interceptador ativo em http://localhost:${proxyPort}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`FlowTracer: Falha ao iniciar proxy na porta ${proxyPort}: ${err.message}`);
    }

    // 3. Registrar o TreeDataProvider da Sidebar
    const treeDataProvider = new TraceTreeDataProvider(traceManager);
    vscode.window.registerTreeDataProvider('flowTracer.views.transactions', treeDataProvider);

    // 4. Registrar Comandos
    const clearHistoryCmd = vscode.commands.registerCommand('flowTracer.clearHistory', () => {
        traceManager.clearHistory();
        vscode.window.showInformationMessage('FlowTracer: Histórico limpo com sucesso.');
    });

    const toggleCaptureCmd = vscode.commands.registerCommand('flowTracer.toggleCapture', () => {
        const active = traceManager.toggleCapture();
        const status = active ? 'retomada' : 'pausada';
        vscode.window.showInformationMessage(`FlowTracer: Captura de tráfego ${status}.`);
    });

    const openDiagramCmd = vscode.commands.registerCommand('flowTracer.openDiagram', (transaction: TraceTransaction) => {
        if (!transaction) {
            vscode.window.showWarningMessage('Nenhuma transação selecionada.');
            return;
        }
        TraceWebviewPanel.createOrShow(context.extensionUri, transaction);
    });

    context.subscriptions.push(
        clearHistoryCmd,
        toggleCaptureCmd,
        openDiagramCmd,
        {
            dispose: () => {
                if (proxyServer) {
                    proxyServer.stop();
                }
            }
        }
    );
}

export function deactivate() {
    if (proxyServer) {
        proxyServer.stop();
    }
}
