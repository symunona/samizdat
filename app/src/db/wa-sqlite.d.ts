// The wa-sqlite VFS this app prefers on the web. The package ships types for most of
// its example VFSes but not for OPFSCoopSyncVFS, so declare the one shape we call.
declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  export class OPFSCoopSyncVFS {
    static create(name: string, module: object): Promise<SQLiteVFS>
  }
}
