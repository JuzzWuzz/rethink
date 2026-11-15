import HADevice from './base'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import AABBDevice from './aabb_device'
import { TEMPERATURES } from './washer_common'
import { Enum } from '@/util/enum'
import { allowExtendedType } from '@/util/casting'

const STATUS = Enum.of({
    Off: 0,
    Standby: 1,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    End: 10,
})

// Model-specific: the shared table labels 0x04 Eco 40–60 instead of Cotton+.
// The Download dial position and its stored/active course are not mapped until observed on this model.
const COURSES = Enum.of({ Cotton: 0x01, 'Cotton+': 0x04, 'TurboWash 39': 0x31 })

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        const enumeration = (name: string, key: string, options: string[]) => ({
            platform: 'sensor' as const,
            device_class: 'enum' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            options,
        })
        const duration = (name: string, key: string) => ({
            platform: 'sensor' as const,
            device_class: 'duration' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            unit_of_measurement: 'min',
            name,
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    status: enumeration('Status', 'status', STATUS.options),
                    course: enumeration('Course', 'course', COURSES.options),
                    temp: enumeration('Temperature', 'temp', TEMPERATURES.options),
                    remaining_time: duration('Remaining time', 'remaining_time'),
                    initial_time: duration('Initial time', 'initial_time'),
                    door_lock: {
                        platform: 'binary_sensor',
                        device_class: 'lock',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, 0x20, 39, this.processStatus)
    }

    processStatus(record: Buffer) {
        const state = record[2]
        // Before starting, idle timer fields can show raw presets not displayed on the panel.
        const hasCycleTime = [4, 6, 7, 8, 10].includes(state)
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('course', state === 0 ? undefined : COURSES.map(record[7]))
        this.publishProperty('temp', state === 0 ? undefined : TEMPERATURES.map(record[11]))
        this.publishProperty('remaining_time', hasCycleTime ? record[3] * 60 + record[4] : undefined)
        this.publishProperty('initial_time', hasCycleTime ? record[5] * 60 + record[6] : undefined)
        // HA's lock binary sensor is OFF when locked. End does not itself imply unlocked.
        this.publishProperty('door_lock', record[17] & 0x40 ? 'OFF' : 'ON')
    }
}
