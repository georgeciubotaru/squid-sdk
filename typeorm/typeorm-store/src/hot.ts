import {assertNotNull} from '@subsquid/util-internal'
import type {EntityManager, EntityMetadata} from 'typeorm'
import {ColumnMetadata} from 'typeorm/metadata/ColumnMetadata'
import {Entity, EntityClass} from './store'
import { getDbType } from '@subsquid/typeorm-config';
import { paramName, tableName } from './dialects';


export interface RowRef {
    table: string
    id: string
}


export interface InsertRecord extends RowRef {
    kind: 'insert'
}


export interface DeleteRecord extends RowRef {
    kind: 'delete'
    fields: Record<string, any>
}


export interface UpdateRecord extends RowRef {
    kind: 'update'
    fields: Record<string, any>
}


export type ChangeRecord = InsertRecord | UpdateRecord | DeleteRecord


export interface ChangeRow {
    block_height: number
    index: number
    change: ChangeRecord
}


export class ChangeTracker {
    private index = 0

    constructor(
        private em: EntityManager,
        private schemaName: string,
        private blockHeight: number
    ) {
    }

    trackInsert(type: EntityClass<Entity>, entities: Entity[]): Promise<void> {
        let meta = this.getEntityMetadata(type)
        return this.writeChangeRows(entities.map(e => {
            return {
                kind: 'insert',
                table: meta.tableName,
                id: e.id
            }
        }))
    }

    async trackUpsert(type: EntityClass<Entity>, entities: Entity[]): Promise<void> {
        let meta = this.getEntityMetadata(type)

        let touchedRows = await this.fetchEntities(
            meta,
            entities.map(e => e.id)
        ).then(
            entities => new Map(
                entities.map(({id, ...fields}) => [id, fields])
            )
        )

        return this.writeChangeRows(entities.map(e => {
            let fields = touchedRows.get(e.id)
            if (fields) {
                return {
                    kind: 'update',
                    table: meta.tableName,
                    id: e.id,
                    fields
                }
            } else {
                return {
                    kind: 'insert',
                    table: meta.tableName,
                    id: e.id,
                }
            }
        }))
    }

    async trackDelete(type: EntityClass<Entity>, ids: string[]): Promise<void> {
        let meta = this.getEntityMetadata(type)
        let deletedEntities = await this.fetchEntities(meta, ids)
        return this.writeChangeRows(deletedEntities.map(e => {
            let {id, ...fields} = e
            return {
                kind: 'delete',
                table: meta.tableName,
                id: id,
                fields
            }
        }))
    }

    private async fetchEntities(meta: EntityMetadata, ids: string[]): Promise<Entity[]> {
        let entities = getDbType() === 'sqlite' ? await this.em.query(
            `SELECT * FROM ${this.escape(meta.tableName)} WHERE id IN(${new Array(ids.length).fill('?').join(',')})`,
            ids
        ) : await this.em.query(
            `SELECT * FROM ${this.escape(meta.tableName)} WHERE id = ANY($1::text[])`,
            [ids]
        )

        // Here we transform the row object returned by the driver to its
        // JSON variant in such a way, that `driver.query('UPDATE entity SET field = $1', [json.field])`
        // would be always correctly handled.
        //
        // It would be better to handle it during change record serialization,
        // but it is just easier to do it here...
        for (let e of entities) {
            for (let key in e) {
                let value = e[key]
                if (value instanceof Uint8Array) {
                    value = Buffer.isBuffer(value)
                        ? value
                        : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
                    e[key] = '\\x' + value.toString('hex').toUpperCase()
                } else if (Array.isArray(value) && isJsonProp(meta, key)) {
                    e[key] = JSON.stringify(value)
                }
            }
        }

        return entities
    }

    private async writeChangeRows(changes: ChangeRecord[]): Promise<void> {
        if (getDbType() === 'sqlite') {
            let sql = `INSERT INTO ${tableName('hot_change_log', this.schemaName)} ("block_height", "index", "change")`
            sql += ` SELECT
                json_extract(j.value, '$[0]') as "block_height", 
                json_extract(j.value, '$[1]') as "index",
                json_extract(j.value, '$[2]') as "change"
            FROM json_each(?) j`

            const params = new Array(changes.length);
            for (let i = 0; i < changes.length; i++) {
                params[i] = [this.blockHeight, ++this.index, JSON.stringify(changes[i])]
            }

            await this.em.query(sql, [JSON.stringify(params)])

            return
        }

        let sql = `INSERT INTO ${tableName('hot_change_log', this.schemaName)} ("block_height", "index", "change")`
        let height = new Array(changes.length)
        let index = new Array(changes.length)
        let change = new Array(changes.length)

        height.fill(this.blockHeight)

        for (let i = 0; i < changes.length; i++) {
            index[i] = this.index++
            change[i] = JSON.stringify(changes[i])
        }

        sql += ' SELECT block_height, "index", change::jsonb'
        sql += ' FROM unnest($1::int[], $2::int[], $3::text[]) AS i("block_height", "index", "change")'

        await this.em.query(sql, [height, index, change])
    }

    private getEntityMetadata(type: EntityClass<Entity>): EntityMetadata {
        return this.em.connection.getMetadata(type)
    }

    private escape(name: string): string {
        return escape(this.em, name)
    }
}

// We should deserialize the value before inserting it into the database.
// SQLite does not support \\x, so we need to convert it to a buffer.
function deserializeValue(value: any): any {
    if (typeof value === 'string' && value.startsWith('\\x')) {
        return Buffer.from(value.slice(2), 'hex')
    }

    return value
}


export async function rollbackBlock(
    statusSchema: string,
    em: EntityManager,
    blockHeight: number
): Promise<void> {
    let changes: (ChangeRow & {change: string})[] = await em.query(
        `SELECT block_height, "index", change FROM ${tableName('hot_change_log', statusSchema)} WHERE block_height = ${paramName(1)} ORDER BY "index" DESC`,
        [blockHeight]
    )

    for (let rec of changes) {
        rec.change = typeof rec.change === 'string' ? JSON.parse(rec.change) : rec.change

        let {table, id} = rec.change
        table = escape(em, table)
        switch(rec.change.kind) {
            case 'insert':
                await em.query(`DELETE FROM ${table} WHERE id = ${paramName(1)}`, [id])
                break
            case 'update': {
                let setPairs = Object.keys(rec.change.fields).map((column, idx) => {
                    return `${escape(em, column)} = ${paramName(idx + 1)}`
                })
                if (setPairs.length) {
                    await em.query(
                        `UPDATE ${table} SET ${setPairs.join(', ')} WHERE id = ${paramName(setPairs.length + 1)}`,
                        [...Object.values(rec.change.fields).map(deserializeValue), id]
                    )
                }
                break
            }
            case 'delete': {
                let columns = ['id', ...Object.keys(rec.change.fields)].map(col => escape(em, col))
                let values = columns.map((col, idx) => paramName(idx + 1))
                await em.query(
                    `INSERT INTO ${table} (${columns}) VALUES (${values.join(', ')})`,
                    [id, ...Object.values(rec.change.fields).map(deserializeValue)]
                )
                break
            }
        }
    }

    await em.query(`DELETE FROM ${tableName('hot_block', statusSchema)} WHERE height = ${paramName(1)}`, [blockHeight])
}


function escape(em: EntityManager, name: string): string {
    return em.connection.driver.escape(name)
}


const ENTITY_COLUMNS = new WeakMap<EntityMetadata, Map<string, ColumnMetadata>>()


function getColumn(meta: EntityMetadata, fieldName: string): ColumnMetadata {
    let columns = ENTITY_COLUMNS.get(meta)
    if (columns == null) {
        columns = new Map()
        ENTITY_COLUMNS.set(meta, columns)
    }
    let col = columns.get(fieldName)
    if (col == null) {
        col = assertNotNull(meta.findColumnWithDatabaseName(fieldName))
        columns.set(fieldName, col)
    }
    return col
}


function isJsonProp(meta: EntityMetadata, fieldName: string): boolean {
    let col = getColumn(meta, fieldName)
    switch(col.type) {
        case 'jsonb':
        case 'json':
            return true
        default:
            return false
    }
}
