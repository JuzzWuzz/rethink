import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as Thinq2Device } from '../thinq2/device'
import AABBDevice from './aabb_device'
import HADevice from './base'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    unpackStatus,
} from './fridge_common'

const DEVICE_CLASS = 0x10
const STATUS_LENGTH = 27
const CELSIUS = 1
const TEMPERATURE_UNIT = 8
const SETTINGS_LENGTH = 41
// The captured F0 17 commands all have these constants, with other untouched slots set to FF.
const SETTING_ZEROS = [21, 22, 23, 26, 31]

const readonlyComponent = (property: string, platform: string, name: string) => ({
    platform,
    name,
    unique_id: '$deviceid-' + property,
    state_topic: '$this/' + property,
})
const writableComponent = (property: string, platform: string, name: string) => ({
    ...readonlyComponent(property, platform, name),
    command_topic: '$this/' + property + '/set',
})

const components = {
    fridge_setpoint: {
        ...writableComponent('fridge_setpoint', 'number', 'Fridge temperature'),
        device_class: 'temperature',
        step: 1,
        ...fridgeRange('C'),
    },
    freezer_setpoint: {
        ...writableComponent('freezer_setpoint', 'number', 'Freezer temperature'),
        device_class: 'temperature',
        step: 1,
        ...freezerRange('C'),
    },
    express_cool: {
        ...writableComponent('express_cool', 'switch', 'Express Fridge'),
        icon: 'mdi:snowflake-variant',
    },
    express_freeze: {
        ...writableComponent('express_freeze', 'switch', 'Express Freeze'),
        icon: 'mdi:snowflake',
    },
    fridge_door: {
        ...readonlyComponent('fridge_door', 'binary_sensor', 'Fridge door'),
        device_class: 'door',
    },
    freezer_door: {
        ...readonlyComponent('freezer_door', 'binary_sensor', 'Freezer door'),
        device_class: 'door',
    },
    water_filter_age: {
        ...readonlyComponent('water_filter_age', 'sensor', 'Water filter age'),
        unit_of_measurement: 'months',
        icon: 'mdi:water',
    },
    water_filter_replacement: {
        ...readonlyComponent('water_filter_replacement', 'binary_sensor', 'Replace water filter'),
        device_class: 'problem',
    },
}

export default class Device extends AABBDevice {
    private isCelsius: boolean | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.config = { ...HADevice.config(meta, { name: 'LG Fridge' }), components }
    }

    start() {
        // Clear retained states from any previous connection until we hear from the fridge again.
        for (const property of Object.keys(components)) this.publishProperty(property, undefined)
        this.publishConfig()
        // Read-only status request used by the related 2RES1VE61NFA2 model.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    override processData(frame: Buffer) {
        // This handler only has a mapping for short, checksummed frames.
        if (frame.length < 6 || frame[0] !== 0xaa || frame[1] !== frame.length || frame[1] === 0xff) return
        if (!AABBDevice.frame(frame.subarray(2, -2)).equals(frame)) return
        super.processData(frame)
    }

    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, DEVICE_CLASS, STATUS_LENGTH, this.processStatus)) return
        if (buf.length !== 4 || buf[0] !== DEVICE_CLASS || buf[1] !== 0xa8) return
        if (buf[3] !== 0 && buf[3] !== 1) return
        // Main fridge and mini Door-in-Door produce the same channel. Channel 0 is not a door state.
        if (buf[2] === 1) this.publishProperty('fridge_door', buf[3] ? 'ON' : 'OFF')
        if (buf[2] === 2) this.publishProperty('freezer_door', buf[3] ? 'ON' : 'OFF')
    }

    private processStatus(record: Buffer) {
        const status = unpackStatus(record)
        this.isCelsius = status.tempUnit === CELSIUS
        const validFridge = this.isCelsius && status.fridgeSetpoint >= 1 && status.fridgeSetpoint <= 7
        const validFreezer = this.isCelsius && status.freezerSetpoint >= 1 && status.freezerSetpoint <= 9
        this.publishProperty(
            'fridge_setpoint',
            validFridge ? convertFridgeTemperature('C', status.fridgeSetpoint) : undefined,
        )
        this.publishProperty(
            'freezer_setpoint',
            validFreezer ? convertFreezerTemperature('C', status.freezerSetpoint) : undefined,
        )
        this.publishProperty(
            'express_cool',
            status.expressCool === 1 ? 'ON' : status.expressCool === 0 ? 'OFF' : undefined,
        )
        this.publishProperty(
            'express_freeze',
            status.expressFreeze === 2 ? 'ON' : status.expressFreeze === 1 ? 'OFF' : undefined,
        )
        const filterAge = status.waterFilter <= 12 ? status.waterFilter : undefined
        this.publishProperty('water_filter_age', filterAge)
        this.publishProperty(
            'water_filter_replacement',
            filterAge === undefined ? undefined : filterAge >= 6 ? 'ON' : 'OFF',
        )
        // The aggregate can initialize both channels when all doors are closed. It
        // cannot identify an open door or override a channel already set by an event.
        if (status.anyDoorOpen === 0x00) {
            if (this.publishCache.get('fridge_door') === undefined) this.publishProperty('fridge_door', 'OFF')
            if (this.publishCache.get('freezer_door') === undefined) this.publishProperty('freezer_door', 'OFF')
        }
    }

    setProperty(property: string, mqttValue: string) {
        const settings = Buffer.alloc(SETTINGS_LENGTH, 0xff)
        for (const offset of SETTING_ZEROS) settings[offset] = 0

        if (property === 'fridge_setpoint' || property === 'freezer_setpoint') {
            // Only Celsius writes have been verified on this model. Require a live status report.
            if (!this.isCelsius || !/^-?\d+$/.test(mqttValue)) return
            const setting = Number(mqttValue)
            const fridge = property === 'fridge_setpoint'
            const range = fridge ? fridgeRange('C') : freezerRange('C')
            if (setting < range.min || setting > range.max) return
            settings[fridge ? 1 : 2] = (fridge ? convertFridgeTemperature : convertFreezerTemperature)('C', setting)
            settings[TEMPERATURE_UNIT] = CELSIUS
        } else if (property === 'express_cool' || property === 'express_freeze') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') return
            const on = mqttValue === 'ON'
            if (property === 'express_cool') settings[16] = on ? 1 : 0
            else settings[3] = on ? 2 : 1
        } else return

        this.send(Buffer.concat([Buffer.from([0xf0, 0x17]), settings]))
    }
}
