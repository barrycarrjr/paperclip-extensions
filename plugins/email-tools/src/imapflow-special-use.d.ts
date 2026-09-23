// imapflow ships no types for its localized special-use folder names. The
// module is plain data plus the matcher imapflow itself uses; see
// sent-copy.ts for why the plugin reads the names directly.
declare module "imapflow/lib/special-use.js" {
  const specialUse: {
    flags: string[];
    names: Record<string, string[]>;
  };
  export default specialUse;
}
