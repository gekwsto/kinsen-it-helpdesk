/**
 * Minimal ambient declaration for html-to-text@10 — the package ships no
 * "types" field and no .d.ts files of its own (confirmed via its
 * package.json), and DefinitelyTyped's @types/html-to-text only covers the
 * older v9 API shape. Scoped deliberately to exactly the surface
 * lib/email-ticket-parser.ts actually calls, rather than pulling in a
 * versionmismatched community package for a handful of options.
 */
declare module "html-to-text" {
  export interface HtmlToTextSelectorOptions {
    ignoreHref?: boolean;
    leadingLineBreaks?: number;
    trailingLineBreaks?: number;
    suffix?: string;
    prefix?: string;
    [key: string]: unknown;
  }

  export interface HtmlToTextSelector {
    selector: string;
    format?: string;
    options?: HtmlToTextSelectorOptions;
  }

  /**
   * The subset of html-to-text's internal BlockTextBuilder actually used by
   * this project's custom cell/row formatters (see
   * lib/email-ticket-parser.ts) — not the library's full internal API.
   * `addInline` appends text using html-to-text's own word/whitespace
   * model (a "pending space" flag, not literal accumulated characters), so
   * calling it with a plain " " between two pieces of content can never
   * produce a doubled-up separator, regardless of whether adjacent
   * whitespace already exists in the source HTML.
   */
  export interface HtmlToTextBuilder {
    addInline(str: string, opts?: { noWordTransform?: boolean }): void;
    addLiteral(str: string): void;
    addLineBreak(): void;
    openBlock(opts?: { leadingLineBreaks?: number; reservedLineLength?: number; isPre?: boolean }): void;
    closeBlock(opts?: { trailingLineBreaks?: number }): void;
  }

  export type HtmlToTextWalk = (nodes: unknown, builder: HtmlToTextBuilder) => void;

  export type HtmlToTextFormatCallback = (
    elem: { children?: unknown[]; [key: string]: unknown },
    walk: HtmlToTextWalk,
    builder: HtmlToTextBuilder,
    formatOptions: HtmlToTextSelectorOptions
  ) => void;

  export interface HtmlToTextOptions {
    wordwrap?: number | false;
    selectors?: HtmlToTextSelector[];
    formatters?: Record<string, HtmlToTextFormatCallback>;
    [key: string]: unknown;
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
