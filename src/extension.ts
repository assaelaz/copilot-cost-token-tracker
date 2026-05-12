import * as vscode from "vscode";
import { DashboardPanel } from "./dashboardPanel";
import { loadPricing } from "./pricing";
export function activate(context: vscode.ExtensionContext) {
  loadPricing(context.extensionUri.fsPath);
  console.log("[Copilot Cost & Token Tracker] Pricing loaded from bundled pricing.json");

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotCost.openDashboard", () => {
      DashboardPanel.createOrShow(context.extensionUri.fsPath);
    }),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "copilotCost.openDashboard";
  statusBar.text = "$(zap) Token Cost";
  statusBar.tooltip = "Open Copilot Cost & Token Tracker Dashboard";
  statusBar.show();
  context.subscriptions.push(statusBar);
}

export function deactivate() {}
