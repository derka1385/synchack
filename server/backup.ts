// Copies a server's data while it runs:  node server/backup.ts [DATA_DIR] DEST
// Restore by stopping the server and pointing DATA_DIR at the copy.
import { Store } from './store.ts'

const [dataDir, dest] = process.argv.length > 3 ? process.argv.slice(2) : [process.env.DATA_DIR ?? 'data', process.argv[2]]
if (!dest) {
  console.error('usage: node server/backup.ts [DATA_DIR] DEST')
  process.exit(1)
}
const store = new Store(dataDir)
store.backup(dest)
store.db.close()
console.log(`backed up ${dataDir} to ${dest}`)
