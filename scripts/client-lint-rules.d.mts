type Report = {
  messages: { ruleId: string | null; message: string; line: number; column: number }[];
  errorCount: number;
};
export function codeRuleIssues(source: string): string[];
export class ClientLint {
  constructor(options?: { allowInlineConfig?: boolean });
  isPathIgnored(path: string): Promise<boolean>;
  lintText(source: string, options: { filePath: string }): Promise<Report[]>;
}
