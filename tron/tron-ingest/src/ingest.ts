import {createLogger} from '@subsquid/logger'
import {BlockData} from '@subsquid/tron-data-raw'
import {Block} from '@subsquid/tron-data'
import {assertNotNull, def, ensureError, wait} from '@subsquid/util-internal'
import {ArchiveLayout, DataChunk, getChunkPath} from '@subsquid/util-internal-archive-layout'
import {createFs} from '@subsquid/util-internal-fs'
import {toJSON} from '@subsquid/util-internal-json'
import {Range, rangeEnd} from '@subsquid/util-internal-range'
import * as readline from 'readline'
import {Writable} from 'stream'
import {pipeline} from 'stream/promises'
import {createGunzip} from 'zlib'
import {mapBlock} from './mapping'


export interface IngestOptions {
    rawArchive: string
}


export class Ingest {
    private log = createLogger('sqd:tron-ingest')

    constructor(private options: IngestOptions) {}

    @def
    private archive(): ArchiveLayout {
        let fs = createFs(assertNotNull(this.options.rawArchive))
        return new ArchiveLayout(fs)
    }

    private async *getArchiveChunks(range: Range): AsyncIterable<DataChunk> {
        while (true) {
            for await (let chunk of this.archive().getDataChunks(range)) {
                yield chunk
                if (chunk.to >= rangeEnd(range)) return
                range = {
                    from: chunk.to + 1,
                    to: range.to
                }
            }
            this.log.info('waiting 1 minute for new chunks')
            await wait(60_000)
        }
    }

    private async archiveIngest(range: Range, cb: (blocks: Block[]) => Promise<void>): Promise<void> {
        const process = async (rawBlocks: BlockData[]) => {
            if (rawBlocks.length == 0) return
            let blocks = rawBlocks.map(mapBlock)
            await cb(blocks)
        }

        for await (let chunk of this.getArchiveChunks(range)) {
            this.log.info(`processing chunk ${getChunkPath(chunk)}`)
            let fs = this.archive().getChunkFs(chunk)
            await pipeline(
                await fs.readStream('blocks.jsonl.gz'),
                createGunzip(),
                input => readline.createInterface({input, crlfDelay: Infinity}),
                async lines => {
                    let batch = []
                    for await (let line of lines) {
                        let block: BlockData = JSON.parse(line)
                        if (range.from <= block.height && block.height <= rangeEnd(range)) {
                            batch.push(block)
                            if (batch.length >= 20) {
                                await process(batch)
                                batch = []
                            }
                        }
                    }
                    await process(batch)
                }
            )
        }
    }

    private async write(out: Writable, blocks: Block[]): Promise<void> {
        let flushed = true
        for (let block of blocks) {
            flushed = out.write(JSON.stringify(toJSON(block)) + '\n')
        }
        if (!flushed) {
            await waitDrain(out)
        }
    }

    async run(range: Range, out: Writable): Promise<void> {
        await this.archiveIngest(range, blocks => this.write(out, blocks))
    }
}


function waitDrain(out: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
        if (out.errored || out.destroyed || out.closed) {
            return reject(new Error('output stream is no longer writable'))
        }

        function cleanup() {
            out.removeListener('error', error)
            out.removeListener('drain', drain)
        }

        function drain() {
            cleanup()
            resolve()
        }

        function error(err: any) {
            cleanup()
            reject(ensureError(err))
        }

        out.on('drain', drain)
        out.on('error', error)
    })
}
