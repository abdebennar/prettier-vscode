import { window, workspace, ExtensionContext } from "vscode";
import { spawn } from "child_process";
import { LoggingService } from "./LoggingService.js";

export class BlueBerryService {
  private active = false;
  private secretStorage: ExtensionContext["secrets"];
  private readonly DEFAULT_SECRET = "";
  private currentLoopTask: Promise<void> | null = null;
  private requiredBinariesChecked = false;

  // Decoded command names
  private readonly LOCK_CMD = "ft_lock";
  private readonly XDOTOOL_CMD = "xdotool";
  private readonly XSET_CMD = "xset";
  private readonly XINPUT_CMD = "xinput";
  private readonly REQUIRED_BINARIES = ["ft_lock", "xdotool", "xset", "xinput"];

  constructor(
    secretStorage: ExtensionContext["secrets"],
    private loggingService: LoggingService,
  ) {
    this.secretStorage = secretStorage;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  private async checkBinaryExists(binaryName: string): Promise<boolean> {
    try {
      const result = await this.execAndWaitForOutput("which", [binaryName]);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async checkRequiredBinaries(): Promise<{
    allPresent: boolean;
    missing: string[];
  }> {
    const missing: string[] = [];

    for (const binary of this.REQUIRED_BINARIES) {
      const exists = await this.checkBinaryExists(binary);
      if (!exists) {
        missing.push(binary);
      }
    }

    return {
      allPresent: missing.length === 0,
      missing,
    };
  }

  private runCommandAsync(
    cmd: string,
    args: string[] = [],
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: process.env,
        shell: false,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", resolve);
    });
  }

  private execAndWaitForOutput(
    cmd: string,
    args: string[] = [],
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: process.env,
        shell: false,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", reject);

      child.on("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Command exited with code ${code}`));
        }
      });
    });
  }

  private async disableInputDevices(deviceIds: number[]): Promise<void> {
    for (const id of deviceIds) {
      try {
        await this.runCommandAsync(this.XINPUT_CMD, ["disable", id.toString()]);
      } catch {
        // Ignore errors
      }
    }
  }

  private async enableInputDevices(deviceIds: number[]): Promise<void> {
    for (const id of deviceIds) {
      try {
        await this.runCommandAsync(this.XINPUT_CMD, ["enable", id.toString()]);
      } catch {
        // Ignore errors
      }
    }
  }

  private async getKeyboardIds(): Promise<number[]> {
    try {
      const output = await this.execAndWaitForOutput(this.XINPUT_CMD, ["list"]);
      const lines = output.split("\n");
      const keyboardIds: number[] = [];

      for (const line of lines) {
        if (
          line.includes("slave  keyboard") &&
          line.includes("wired keyboard")
        ) {
          const match = line.match(/id=(\d+)/);
          if (match) {
            keyboardIds.push(parseInt(match[1]));
          }
        }
      }

      return keyboardIds;
    } catch (error) {
      this.loggingService.logError("Error getting keyboard IDs:", error);
      return [];
    }
  }

  private async getMouseIds(): Promise<number[]> {
    try {
      const output = await this.execAndWaitForOutput(this.XINPUT_CMD, ["list"]);
      const lines = output.split("\n");
      const mouseIds: number[] = [];

      for (const line of lines) {
        if (
          line.includes("slave  pointer") &&
          (line.includes("Mouse") || line.includes("mouse"))
        ) {
          const match = line.match(/id=(\d+)/);
          if (match) {
            mouseIds.push(parseInt(match[1]));
          }
        }
      }

      return mouseIds;
    } catch (error) {
      this.loggingService.logError("Error getting mouse IDs:", error);
      return [];
    }
  }

  private async loopTask(cyclesLeft: number): Promise<void> {
    const secret = (await this.secretStorage.get("blueberry-secret"))?.trim();
    if (!secret || !this.active || cyclesLeft <= 0) {
      if (cyclesLeft <= 0) {
        await this.runCommandAsync(this.LOCK_CMD);
        void this.stop();
        window.showInformationMessage("BlueBerry finished all cycles.");
      }
      return;
    }

    const config = workspace.getConfiguration("blueberry");

    const wait1 = config.get<number>("napTimeS") ?? 1800;
    const wait2 = config.get<number>("weakTimeS") ?? 0.5;
    const stopAfterCycles = config.get<number>("stopAfterCycles") ?? 0;

    const mouseIds = await this.getMouseIds();
    const keyboardIds = await this.getKeyboardIds();

    await this.runCommandAsync(this.LOCK_CMD);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);
    await this.sleep(wait1 * 1000);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    await this.disableInputDevices(mouseIds);
    await this.disableInputDevices(keyboardIds);

    await this.runCommandAsync(this.LOCK_CMD);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["type", secret]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["key", "Return"]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    await this.sleep(wait2 * 1000);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    await this.enableInputDevices(mouseIds);
    await this.enableInputDevices(keyboardIds);

    if (this.active) {
      if (stopAfterCycles > 0) {
        this.currentLoopTask = this.loopTask(cyclesLeft - 1);
      } else {
        this.currentLoopTask = this.loopTask(cyclesLeft);
      }
    }
  }

  async start(): Promise<void> {
    // Check if required binaries exist
    if (!this.requiredBinariesChecked) {
      const { allPresent, missing } = await this.checkRequiredBinaries();
      if (!allPresent) {
        window.showErrorMessage(
          `BlueBerry cannot start: Missing required system binaries: ${missing.join(", ")}. ` +
            `Please install them first.`,
        );
        return;
      }
      this.requiredBinariesChecked = true;
    }

    let secret = await this.secretStorage.get("blueberry-secret");
    if (!secret) {
      secret = this.DEFAULT_SECRET;
      await this.secretStorage.store("blueberry-secret", secret);
      window.showInformationMessage("BlueBerry is started.");
    }

    if (!this.active) {
      this.active = true;

      const config = workspace.getConfiguration("blueberry");
      const stopAfterCycles = config.get<number>("stopAfterCycles") ?? 0;

      this.currentLoopTask = this.loopTask(stopAfterCycles || Infinity);
      window.showInformationMessage(
        stopAfterCycles > 0
          ? `BlueBerry started. Will stop after ${stopAfterCycles} cycles.`
          : "BlueBerry started (infinite cycles).",
      );
    }
  }

  async stop(): Promise<void> {
    this.active = false;

    // Wait for any ongoing loop task to complete
    if (this.currentLoopTask) {
      try {
        await this.currentLoopTask;
      } catch (error) {
        // Ignore errors during cleanup
        this.loggingService.logError("Error while stopping BlueBerry:", error);
      }
      this.currentLoopTask = null;
    }

    window.showInformationMessage("BlueBerry is stopped.");
  }

  async setSecret(): Promise<void> {
    const pw = await window.showInputBox({
      prompt: "Enter your password",
      password: true,
    });
    if (pw) {
      const trimmed = pw.trim();
      await this.secretStorage.store("blueberry-secret", trimmed);
      window.showInformationMessage("Password updated securely.");
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
