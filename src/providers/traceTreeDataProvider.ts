import * as vscode from 'vscode';
import { TraceManager } from '../core/traceManager';
import { TraceTreeItem } from './traceTreeItem';
import { TraceTransaction } from '../models/transaction';

export interface ProxyStatus {
    isRunning: boolean;
    inPort: number;
    targetPort: number;
}

export class StatusTreeItem extends vscode.TreeItem {
    constructor(status: ProxyStatus) {
        if (status.isRunning) {
            super(`🟢 In: [${status.inPort}] ➔ Out: [${status.targetPort}]`, vscode.TreeItemCollapsibleState.None);
            this.description = 'Ativo';
            this.tooltip = new vscode.MarkdownString(
                `### 🟢 FlowTracer Interceptor Ativo\n\n` +
                `- **Porta de Entrada (In):** \`${status.inPort}\` (onde Swagger/Postman chamam)\n` +
                `- **Porta de Destino (Out):** \`${status.targetPort}\` (sua API real)\n\n` +
                `*Clique para reconfigurar as portas In/Out.*`
            );
            this.iconPath = new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('testing.iconPassed'));
            this.command = {
                command: 'flowTracer.configurePorts',
                title: 'Configurar Portas'
            };
        } else {
            super(`🔴 Interceptor Parado`, vscode.TreeItemCollapsibleState.None);
            this.description = `In: [${status.inPort}] ➔ Out: [${status.targetPort}]`;
            this.tooltip = new vscode.MarkdownString(
                `### 🔴 FlowTracer Interceptor Parado\n\n` +
                `Clique no botão de **Play ▶️** no topo ou aqui para iniciar a interceptação.\n\n` +
                `*Portas configuradas: In [${status.inPort}] ➔ Out [${status.targetPort}]*`
            );
            this.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('testing.iconFailed'));
            this.command = {
                command: 'flowTracer.startProxy',
                title: 'Iniciar Interceptor'
            };
        }
    }
}

export class EmptyInfoTreeItem extends vscode.TreeItem {
    constructor() {
        super('Aguardando requisições...', vscode.TreeItemCollapsibleState.None);
        this.description = 'faça uma chamada via Swagger/Postman';
        this.iconPath = new vscode.ThemeIcon('info');
    }
}

export class TraceTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly traceManager: TraceManager,
        private readonly getStatus: () => ProxyStatus
    ) {
        this.traceManager.onTransactionsUpdated(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            const status = this.getStatus();
            const items: vscode.TreeItem[] = [new StatusTreeItem(status)];

            const transactions = this.traceManager.getTransactions();
            if (transactions.length === 0) {
                items.push(new EmptyInfoTreeItem());
            } else {
                items.push(...transactions.map((t) => new TraceTreeItem(t)));
            }

            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}
