/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import * as Util from "util";
import * as Long from "long";
import {ComplexObjectType} from "../ObjectType";
import BinaryTypeStorage from "./BinaryTypeStorage";
import BinaryUtils from "./BinaryUtils";
import BinaryCommunicator from "./BinaryCommunicator";
import {IgniteClientError} from "../Errors";

export default class BinaryType {

    private _id: number;
    private _fields: Map<number, BinaryField>;
    private _schemas: Map<number, BinarySchema>;
    private _name: string;
    private _isEnum: boolean;
    private _enumValues: [string, number][];

    constructor(name: string) {
        this._name = name;
        this._id = BinaryType._calculateId(name);
        this._fields = new Map<number, BinaryField>();
        this._schemas = new Map<number, BinarySchema>();
        this._isEnum = false;
        this._enumValues = null;
    }

    get id() {
        return this._id;
    }

    set id(val: number) {
        this._id = val;
    }

    get name() {
        return this._name;
    }

    get fields() {
        return [...this._fields.values()];
    }

    getField(fieldId) {
        return this._fields.get(fieldId);
    }

    hasField(fieldId) {
        return this._fields.has(fieldId);
    }

    removeField(fieldId: number) {
        return this._fields.delete(fieldId);
    }

    setField(field: BinaryField) {
        this._fields.set(field.id, field);
    }

    hasSchema(schemaId: number) {
        return this._schemas.has(schemaId);
    }

    addSchema(schema: BinarySchema) {
        if (!this.hasSchema(schema.id)) {
            this._schemas.set(schema.id, schema);
        }
    }

    getSchema(schemaId: number) {
        return this._schemas.get(schemaId);
    }

    merge(binaryType, binarySchema) {
        let fieldId;
        for (let field of binaryType.fields) {
            fieldId = field.id;
            if (this.hasField(fieldId)) {
                if (this.getField(fieldId).typeCode !== field.typeCode) {
                    throw IgniteClientError.serializationError(
                        true, Util.format('type conflict for field "%s" of complex object type "%s"', field.name, this._name));
                }
            }
            else {
                this.setField(field);
            }
        }
        this.addSchema(binarySchema);
    }

    clone() {
        const result = new BinaryType(this._name);
        result._id = this._id;
        result._fields = new Map(this._fields.entries());
        result._schemas = new Map(this._schemas.entries());
        result._isEnum = this._isEnum;
        return result;
    }

    isValid() {
        for (let field of this._fields.values()) {
            if (!field.isValid()) {
                return false;
            }
        }
        return this._name !== null;
    }

    get enumValues(): [string, number][] {
        return this._enumValues;
    }

    get isEnum(): boolean {
        return this._isEnum;
    }

    static _calculateId(name): number {
        return BinaryUtils.strHashCodeLowerCase(name);
    }

    async _write(buffer) {
        // type id
        buffer.writeInteger(this._id);
        // type name
        BinaryCommunicator.writeString(buffer, this._name);
        // affinity key field name
        BinaryCommunicator.writeString(buffer, null);
        // fields count
        buffer.writeInteger(this._fields.size);
        // fields
        for (let field of this._fields.values()) {
            await field._write(buffer);
        }
        await this._writeEnum(buffer);
        // schemas count
        buffer.writeInteger(this._schemas.size);
        for (let schema of this._schemas.values()) {
            await schema._write(buffer);
        }
    }

    async _writeEnum(buffer) {
        buffer.writeBoolean(this._isEnum);
        if (this._isEnum) {
            const length = this._enumValues ? this._enumValues.length : 0;
            buffer.writeInteger(length);
            if (length > 0) {
                for (let [key, value] of this._enumValues) {
                    BinaryCommunicator.writeString(buffer, key);
                    buffer.writeInteger(value);
                }
            }
        }
    }

    async _read(buffer) {
        // type id
        this._id = buffer.readInteger();
        // type name
        this._name = BinaryCommunicator.readString(buffer);
        // affinity key field name
        BinaryCommunicator.readString(buffer);
        // fields count
        const fieldsCount = buffer.readInteger();
        // fields
        let field;
        for (let i = 0; i < fieldsCount; i++) {
            field = new BinaryField(null, null);
            await field._read(buffer);
            this.setField(field);
        }
        await this._readEnum(buffer);
        // schemas count
        const schemasCount = buffer.readInteger();
        // schemas
        let schema;
        for (let i = 0; i < schemasCount; i++) {
            schema = new BinarySchema();
            await schema._read(buffer);
            this.addSchema(schema);
        }
    }

    async _readEnum(buffer) {
        this._isEnum = buffer.readBoolean();
        if (this._isEnum) {
            const valuesCount = buffer.readInteger();
            this._enumValues = new Array<[string, number]>(valuesCount);
            for (let i = 0; i < valuesCount; i++) {
                this._enumValues[i] = [BinaryCommunicator.readString(buffer), buffer.readInteger()];
            }
        }
    }
}

/** FNV1 hash offset basis. */
const FNV1_OFFSET_BASIS = 0x811C9DC5;
/** FNV1 hash prime. */
const FNV1_PRIME = 0x01000193;

export class BinarySchema {
    private _id: number;
    private _fieldIds: Set<number>;
    private _isValid: boolean;
    constructor() {
        this._id = BinarySchema._schemaInitialId();
        this._fieldIds = new Set<number>();
        this._isValid = true;
    }

    get id() {
        return this._id;
    }

    get fieldIds() {
        return [...this._fieldIds];
    }

    finalize() {
        if (!this._isValid) {
            this._id = BinarySchema._schemaInitialId();
            for (let fieldId of this._fieldIds) {
                this._id = BinarySchema._updateSchemaId(this._id, fieldId);
            }
            this._isValid = true;
        }
    }

    clone() {
        const result = new BinarySchema();
        result._id = this._id;
        result._fieldIds = new Set(this._fieldIds);
        result._isValid = this._isValid;
        return result;
    }

    addField(fieldId) {
        if (!this.hasField(fieldId)) {
            this._fieldIds.add(fieldId);
            if (this._isValid) {
                this._id = BinarySchema._updateSchemaId(this._id, fieldId);
            }
        }
    }

    removeField(fieldId) {
        if (this._fieldIds.delete(fieldId)) {
            this._isValid = false;
        }
    }

    hasField(fieldId) {
        return this._fieldIds.has(fieldId);
    }

    static _schemaInitialId(): number {
        return FNV1_OFFSET_BASIS | 0;
    }

    static _updateSchemaId(schemaId, fieldId) {
        schemaId = BinarySchema._updateSchemaIdPart(schemaId, fieldId & 0xFF);
        schemaId = BinarySchema._updateSchemaIdPart(schemaId, (fieldId >> 8) & 0xFF);
        schemaId = BinarySchema._updateSchemaIdPart(schemaId, (fieldId >> 16) & 0xFF);
        schemaId = BinarySchema._updateSchemaIdPart(schemaId, (fieldId >> 24) & 0xFF);
        return schemaId;
    }

    static _updateSchemaIdPart(schemaId, fieldIdPart) {
        schemaId = schemaId ^ fieldIdPart;
        schemaId = Long.fromValue(schemaId).multiply(FNV1_PRIME).getLowBits();
        return schemaId;
    }

    async _write(buffer) {
        this.finalize();
        // schema id
        buffer.writeInteger(this._id);
        // fields count
        buffer.writeInteger(this._fieldIds.size);
        // field ids
        for (let fieldId of this._fieldIds) {
            buffer.writeInteger(fieldId);
        }
    }

    async _read(buffer) {
        // schema id
        this._id = buffer.readInteger();
        // fields count
        const fieldsCount = buffer.readInteger();
        // field ids
        for (let i = 0; i < fieldsCount; i++) {
            this._fieldIds.add(buffer.readInteger());
        }
    }
}

export class BinaryField {
    private _name: string;
    private _id: number;
    private _typeCode: number;
    constructor(name: string, typeCode: number) {
        this._name = name;
        this._id = BinaryField._calculateId(name);
        this._typeCode = typeCode;
    }

    get id() {
        return this._id;
    }

    get name() {
        return this._name;
    }

    get typeCode() {
        return this._typeCode;
    }

    isValid() {
        return this._name !== null;
    }

    static _calculateId(name) {
        return BinaryUtils.strHashCodeLowerCase(name);
    }

    async _write(buffer) {
        // field name
        BinaryCommunicator.writeString(buffer, this._name);
        // type code
        buffer.writeInteger(this._typeCode);
        // field id
        buffer.writeInteger(this._id);
    }

    async _read(buffer) {
        // field name
        this._name = BinaryCommunicator.readString(buffer);
        // type code
        this._typeCode = buffer.readInteger();
        // field id
        this._id = buffer.readInteger();
    }
}

export class BinaryTypeBuilder {
    private _schema: BinarySchema;
    private _type: BinaryType;
    private _fromStorage: boolean;

    static fromTypeName(typeName) {
        let result = new BinaryTypeBuilder();
        result._init(typeName);
        return result;
    }

    static async fromTypeId(communicator: BinaryCommunicator, typeId: number, schemaId: number) {
        let result = new BinaryTypeBuilder();
        let type = await communicator.typeStorage.getType(typeId, schemaId);
        if (type) {
            result._type = type;
            if (schemaId !== null) {
                result._schema = type.getSchema(schemaId);
                if (!result._schema) {
                    throw IgniteClientError.serializationError(
                        false, Util.format('schema id "%d" specified for complex object of type "%s" not found',
                            schemaId, type.name));
                }
                result._fromStorage = true;
            }
            else {
                result._schema = new BinarySchema();
            }
            return result;
        }
        result._init(null);
        result._type.id = typeId;
        return result;
    }

    static fromObject(jsObject, complexObjectType = null) {
        if (complexObjectType) {
            return BinaryTypeBuilder.fromComplexObjectType(complexObjectType, jsObject);
        }
        else {
            const result = new BinaryTypeBuilder();
            result._fromComplexObjectType(new ComplexObjectType(jsObject), jsObject);
            return result;
        }
    }

    static fromComplexObjectType(complexObjectType: ComplexObjectType, jsObject: any) {
        let result = new BinaryTypeBuilder();
        const typeInfo = BinaryTypeStorage.getByComplexObjectType(complexObjectType);
        if (typeInfo) {
            result._type = typeInfo[0];
            result._schema = typeInfo[1];
            result._fromStorage = true;
        }
        else {
            result._fromComplexObjectType(complexObjectType, jsObject);
            BinaryTypeStorage.setByComplexObjectType(complexObjectType, result._type, result._schema);
        }
        return result;
    }

    getTypeId() {
        return this._type.id;
    }

    getTypeName() {
        return this._type.name;
    }

    getSchemaId() {
        return this._schema.id;
    }

    getFields() {
        return this._type.fields;
    }

    getField(fieldId) {
        return this._type.getField(fieldId);
    }

    get schema() {
        return this._schema;
    }

    setField(fieldName, fieldTypeCode = null) {
        const fieldId = BinaryField._calculateId(fieldName);
        if (!this._type.hasField(fieldId) || !this._schema.hasField(fieldId) ||
            this._type.getField(fieldId).typeCode !== fieldTypeCode) {
            this._beforeModify();
            this._type.setField(new BinaryField(fieldName, fieldTypeCode));
            this._schema.addField(fieldId);
        }
    }

    removeField(fieldName) {
        const fieldId = BinaryField._calculateId(fieldName);
        if (this._type.hasField(fieldId)) {
            this._beforeModify();
            this._type.removeField(fieldId);
            this._schema.removeField(fieldId);
        }
    }

    async finalize(communicator) {
        this._schema.finalize();
        await communicator.typeStorage.addType(this._type, this._schema);
    }

    constructor() {
        this._type = null;
        this._schema = null;
        this._fromStorage = false;
    }

    _fromComplexObjectType(complexObjectType, jsObject) {
        this._init(complexObjectType._typeName);
        if (complexObjectType._template) {
            this._setFields(complexObjectType, complexObjectType._template, jsObject);
        }
    }

    _init(typeName) {
        this._type = new BinaryType(typeName);
        this._schema = new BinarySchema();
    }

    _beforeModify() {
        if (this._fromStorage) {
            this._type = this._type.clone();
            this._schema = this._schema.clone();
            this._fromStorage = false;
        }
    }

    _setFields(complexObjectType, objectTemplate, jsObject) {
        let fieldType;
        for (let fieldName of BinaryUtils.getJsObjectFieldNames(objectTemplate)) {
            fieldType = complexObjectType._getFieldType(fieldName);
            if (!fieldType && jsObject[fieldName]) {
                fieldType = BinaryUtils.calcObjectType(jsObject[fieldName]);
            }
            this.setField(fieldName, BinaryUtils.getTypeCode(fieldType));
        }
    }
}
