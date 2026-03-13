import { execaCommand } from "execa";

export type ValidationResult = { ok: true } | { ok: false; command: string; output: string };

export async function runValidation(commands: string[], cwd: string): Promise<ValidationResult> {
  for (const command of commands) {
    try {
      await execaCommand(command, { cwd });
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      const raw = [stdout, stderr].filter(Boolean).join("\n");
      const lines = raw.split("\n");
      const output = lines.slice(-50).join("\n");
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}
