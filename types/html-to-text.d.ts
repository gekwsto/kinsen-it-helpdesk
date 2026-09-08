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
    [key: string]: unknown;
  }

  export interface HtmlToTextSelector {
    selector: string;
    format?: string;
    options?: HtmlToTextSelectorOptions;
  }

  export interface HtmlToTextOptions {
    wordwrap?: number | false;
    selectors?: HtmlToTextSelector[];
    [key: string]: unknown;
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
