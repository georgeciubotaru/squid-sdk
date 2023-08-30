import type {QualifiedName, Runtime} from '@subsquid/substrate-runtime'
import * as sts from '@subsquid/substrate-runtime/lib/sts'
import assert from 'assert'


export {sts}


/**
 * Hex encoded binary string
 */
export type Bytes = string


interface Block {
    _runtime: Runtime
}


interface Event {
    block: Block
    name: QualifiedName
    args: unknown
}


interface Call {
    block: Block
    name: QualifiedName
    args: unknown
}


export class EventType<T extends sts.Type> {
    constructor(private type: T) {}

    is(event: Event): boolean {
        return event.block._runtime.events.checkType(event.name, this.type)
    }

    decode(event: Event): sts.GetType<T> {
        assert(this.is(event))
        return event.block._runtime.decodeEventRecordArguments(event)
    }
}


export class CallType<T extends sts.Type> {
    constructor(private type: T) {}

    is(call: Call): boolean {
        return call.block._runtime.calls.checkType(call.name, this.type)
    }

    decode(call: Call): sts.GetType<T> {
        assert(this.is(call))
        return call.block._runtime.decodeCallRecordArguments(call)
    }
}
