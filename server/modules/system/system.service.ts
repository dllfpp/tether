import { isLiveForkInstall } from '@/modules/live-sessions/index.js';

type SystemUpdateCommandResult = {
  exitCode: number | null;
  output: string;
  errorOutput: string;
};

type SystemUpdateDependencies = {
  appRoot: string;
  homeDirectory: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  environment: NodeJS.ProcessEnv;
  runShellCommand(
    command: string,
    workingDirectory: string,
    environment: NodeJS.ProcessEnv,
    onOutput: (output: string) => void,
    onErrorOutput: (errorOutput: string) => void,
  ): Promise<SystemUpdateCommandResult>;
  logInfo(message: string, detail?: string): void;
  logError(message: string, detail?: string): void;
};

/**
 * Creates the update workflow used by the system module and its focused tests.
 * Runtime-specific process spawning stays behind the injected command adapter.
 */
export function createSystemUpdateService(dependencies: SystemUpdateDependencies) {
  return {
    /** Selects and executes the correct update workflow for this installation. */
    async updateSystem() {
      // CloudCLI live: the built-in update would install the original CloudCLI
      // and report success without changing this copy (live-sessions module).
      if (isLiveForkInstall(dependencies.appRoot)) {
        return {
          success: false as const,
          error: 'This is CloudCLI live, a modified copy of CloudCLI. A new original release has to be merged into the fork (ask Claude to align CloudCLI live); the built-in update would install the original elsewhere instead.',
        };
      }

      const updateCommand = dependencies.isPlatform
        ? 'npm run update:platform'
        : dependencies.installMode === 'git'
          ? 'git checkout main && git pull && npm install'
          : 'npm install -g @cloudcli-ai/cloudcli@latest';
      const workingDirectory = dependencies.isPlatform || dependencies.installMode === 'git'
        ? dependencies.appRoot
        : dependencies.homeDirectory;

      dependencies.logInfo('Starting system update from directory:', workingDirectory);

      try {
        const result = await dependencies.runShellCommand(
          updateCommand,
          workingDirectory,
          dependencies.environment,
          (output) => dependencies.logInfo('Update output:', output),
          (errorOutput) => dependencies.logError('Update error:', errorOutput),
        );

        if (result.exitCode === 0) {
          return {
            success: true as const,
            output: result.output || 'Update completed successfully',
            message: 'Update completed. Please restart the server to apply changes.',
          };
        }

        return {
          success: false as const,
          error: 'Update command failed',
          output: result.output,
          errorOutput: result.errorOutput,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logError('Update process error:', message);
        return {
          success: false as const,
          error: message,
        };
      }
    },
  };
}
