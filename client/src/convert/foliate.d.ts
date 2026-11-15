// Minimal types for the parts of foliate-js (MIT) used to read Kindle books.
declare module 'foliate-js/mobi.js' {
  export interface MobiTocItem {
    label?: string;
    href: string;
    subitems?: MobiTocItem[];
  }
  export interface MobiSection {
    id?: number;
    linear?: string;
    load?: () => Promise<string>;
  }
  export interface MobiBook {
    sections: MobiSection[];
    toc?: MobiTocItem[];
    metadata: {
      identifier?: string;
      title?: string;
      author?: string[];
      language?: string;
      description?: string;
      publisher?: string;
    };
    rendition?: { layout?: string };
    dir?: string;
    getCover?: () => Promise<Blob | undefined>;
    resolveHref(href: string): { index: number; anchor: (doc: Document) => Element | null } | undefined | Promise<{ index: number; anchor: (doc: Document) => Element | null } | undefined>;
    destroy?: () => void;
  }
  export class MOBI {
    constructor(options: { unzlib: (data: Uint8Array) => Uint8Array });
    open(file: Blob): Promise<MobiBook>;
  }
}

declare module 'foliate-js/vendor/fflate.js' {
  export function unzlibSync(data: Uint8Array): Uint8Array;
}
