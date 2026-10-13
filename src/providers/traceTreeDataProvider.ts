import * as vscode from 'vscode';
import { TraceManager } from '../core/traceManager';
import { TraceTreeItem } from './traceTreeItem';

export class TraceTreeDataProvider implements vscode.TreeDataProvider<TraceTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TraceTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly traceManager: TraceManager) {
        this.traceManager.onTransactionsUpdated(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: TraceTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: TraceTreeItem): Thenable<TraceTreeItem[]> {
        if (!element) {
            const transactions = this.traceManager.getTransactions();
            const items = transactions.map((t) => new TraceTreeItem(t));
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
}
