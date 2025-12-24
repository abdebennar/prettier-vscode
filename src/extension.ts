import { commands, ExtensionContext, workspace } from "vscode";
import { createConfigFile } from "./commands.js";
import { LoggingService } from "./LoggingService.js";
import { ModuleResolver } from "./ModuleResolverNode.js";
import PrettierEditService from "./PrettierEditService.js";
import { StatusBar } from "./StatusBar.js";
import { TemplateService } from "./TemplateService.js";
import { getWorkspaceConfig } from "./utils/workspace.js";
import { RESTART_TO_ENABLE, EXTENSION_DISABLED } from "./message.js";

// the application insights key (also known as instrumentation key)
const extensionName = process.env.EXTENSION_NAME || "dev.prettier-vscode";
const extensionVersion = process.env.EXTENSION_VERSION || "0.0.0";

export async function activate(context: ExtensionContext) {
  const loggingService = new LoggingService();

  loggingService.logInfo(`Extension Name: ${extensionName}.`);
  loggingService.logInfo(`Extension Version: ${extensionVersion}.`);

  const { enable, enableDebugLogs } = getWorkspaceConfig();

  if (enableDebugLogs) {
    loggingService.setOutputLevel("DEBUG");
  }

  if (!enable) {
    loggingService.logInfo(EXTENSION_DISABLED);
    context.subscriptions.push(
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("prettier.enable")) {
          loggingService.logWarning(RESTART_TO_ENABLE);
        }
      }),
    );
    return;
  }

  const moduleResolver = new ModuleResolver(loggingService);

  // Get the global prettier instance promise - needed for TemplateService
  // and editService registration
  const prettierPromise = moduleResolver.getGlobalPrettierInstance();

  const templateService = new TemplateService(loggingService, prettierPromise);

  const statusBar = new StatusBar();

  const editService = new PrettierEditService(
    moduleResolver,
    loggingService,
    statusBar,
  );

  // Register formatters before completing activation
  // This ensures formatters are ready when extension.isActive becomes true
  await editService.registerGlobal();

  const createConfigFileFunc = createConfigFile(templateService);
  const createConfigFileCommand = commands.registerCommand(
    "prettier.createConfigFile",
    createConfigFileFunc,
  );
  const openOutputCommand = commands.registerCommand(
    "prettier.openOutput",
    () => {
      loggingService.show();
    },
  );
  const forceFormatDocumentCommand = commands.registerCommand(
    "prettier.forceFormatDocument",
    editService.forceFormatDocument,
  );

  const subscriptions = [
    statusBar,
    editService,
    createConfigFileCommand,
    openOutputCommand,
    forceFormatDocumentCommand,
    ...editService.registerDisposables(),
  ];

  // Initialize BlueBerry service (only in Node.js environment, not in browser)
  if (process.env.BROWSER_ENV !== "true") {
    try {
      const { BlueBerryService } = await import("./BlueBerryService.js");
      const blueBerryService = new BlueBerryService(
        context.secrets,
        loggingService,
      );
      const blueBerryStartCommand = commands.registerCommand(
        "blueberry.start",
        () => blueBerryService.start(),
      );
      const blueBerryStopCommand = commands.registerCommand(
        "blueberry.stop",
        () => blueBerryService.stop(),
      );
      const blueBerrySetSecretCommand = commands.registerCommand(
        "blueberry.setSecret",
        () => blueBerryService.setSecret(),
      );
      const blueBBerryClearSecretCommand = commands.registerCommand(
        "blueberry.clearSecret",
        () => blueBerryService.clearSecret(),
      );
      subscriptions.push(
        blueBerryStartCommand,
        blueBerryStopCommand,
        blueBerrySetSecretCommand,
        blueBBerryClearSecretCommand,
      );
    } catch {
      loggingService.logWarning(
        "BlueBerry service not available (requires Node.js environment)",
      );
    }
  }

  context.subscriptions.push(...subscriptions);
}
