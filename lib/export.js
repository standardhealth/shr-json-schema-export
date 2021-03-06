// export SHR specification content as a hierarchy in JSON format
// Author: John Gibson
// Derived from export SHR specification content as a hierarchy in JSON format by Greg Quinn

const bunyan = require('bunyan');
const {Identifier, IdentifiableValue, ChoiceValue, TBD, IncompleteValue, ValueSetConstraint, IncludesCodeConstraint, IncludesTypeConstraint, CodeConstraint, CardConstraint, TypeConstraint, SubsetConstraint, INHERITED, OVERRIDDEN, BooleanConstraint, FixedValueConstraint, MODELS_INFO, PRIMITIVE_NS} = require('shr-models');
const builtinSchema = require('./schemas/cimpl.builtin.schema.json');

var rootLogger = bunyan.createLogger({name: 'shr-json-schema-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}


/**
 * Converts a group of specifications into JSON Schema.
 * @param {Specifications} expSpecifications - a fully expanded Specifications object.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the entryType field.
 * @param {boolean=} flat - if true then the generated schema will not be hierarchical. Defaults to false.
 * @return {Object.<string, Object>} A mapping of schema ids to JSON Schema definitions.
 */
function exportToJSONSchema(expSpecifications, baseSchemaURL, baseTypeURL, flat = false) {
  const namespaceResults = {
    'https://standardhealthrecord.org/schema/cimpl/builtin': builtinSchema
  };
  const endOfTypeURL = baseTypeURL[baseTypeURL.length - 1];
  if (endOfTypeURL !== '#' && endOfTypeURL !== '/') {
    baseTypeURL += '/';
  }
  for (const ns of expSpecifications.namespaces.all) {
    const lastLogger = logger;
    logger = logger.child({ shrId: ns.namespace});
    try {
      // 08001, 'Exporting namespace.',,
      logger.debug('08001');
      if (flat) {
        const { schemaId, schema } = flatNamespaceToSchema(ns, expSpecifications.dataElements, baseSchemaURL, baseTypeURL);
        namespaceResults[schemaId] = schema;
      } else {
        const { schemaId, schema } = namespaceToSchema(ns, expSpecifications.dataElements, baseSchemaURL, baseTypeURL);
        namespaceResults[schemaId] = schema;
      }
      // 08002, 'Finished exporting namespace.',,
      logger.debug('08002');
    } finally {
      logger = lastLogger;
    }
  }

  return namespaceResults;
}

/**
 * Converts a namespace into a JSON Schema.
 * @param {Namespace} ns - the namespace of the schema.
 * @param {DataElementSpecifications} dataElementsSpecs - the elements in the namespace.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the entryType field.
 * @return {{schemaId: string, schema: Object}} The schema id and the JSON Schema definition.
 */
function namespaceToSchema(ns, dataElementsSpecs, baseSchemaURL, baseTypeURL) {
  const dataElements = dataElementsSpecs.byNamespace(ns.namespace);
  const schemaId = `${baseSchemaURL}/${namespaceToURLPathSegment(ns.namespace)}`;
  let schema = {
    $schema: 'http://json-schema.org/draft-04/schema#',
    id: schemaId,
    title: 'TODO: Figure out what the title should be.',
    definitions: {}
  };
  const entryRef = 'https://standardhealthrecord.org/schema/cimpl/builtin#/definitions/Entry';
  if (ns.description) {
    schema.description = ns.description;
  }
  const nonEntryEntryTypeField = {
    type: 'string',
    format: 'uri'
  };

  const defs = dataElements.sort(function(l,r) {return l.identifier.name.localeCompare(r.identifier.name);});
  const entryRefs = [];
  for (const def of defs) {
    const lastLogger = logger;
    logger = logger.child({ shrId: def.identifier.fqn});
    try {
      // 08003, 'Exporting element',,
      logger.debug('08003');
      let schemaDef = {
        type: 'object',
        properties: {}
      };
      let wholeDef = schemaDef;
      const tbdParentDescriptions = [];
      let requiredProperties = [];
      let needsEntryType = false;
      if (def.isEntry || def.basedOn.length) {
        wholeDef = { allOf: [] };
        let hasEntryParent = false;
        for (const supertypeId of def.basedOn) {
          if (supertypeId instanceof TBD) {
            if (supertypeId.text) {
              tbdParentDescriptions.push(supertypeId.text);
            } else {
              tbdParentDescriptions.push('TBD');
            }
          } else {
            const parent = dataElementsSpecs.findByIdentifier(supertypeId);
            if (!parent) {
              //18008, 'Could not find definition for ${supertype1} which is a supertype of ${def1}' , 'Unknown' , 'errorNumber'
              logger.error({supertype1 : supertypeId.toString(), def1 : def.identifier.toString() },'18008' );
            } else {
              hasEntryParent = hasEntryParent || parent.isEntry;
            }
            wholeDef.allOf.push({ $ref: makeRef(supertypeId, ns, baseSchemaURL)});
          }
        }
        if (def.isEntry && (!hasEntryParent)) {
          wholeDef.allOf.splice(0, 0, { $ref: entryRef });
        }
        wholeDef.allOf.push(schemaDef);
      } else {
        needsEntryType = true;
      }

      const tbdFieldDescriptions = [];
      if (def.value) {
        if (def.value.inheritance !== INHERITED) {
          let { value, required, tbd } = convertDefinition(def.value, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
          if (required) {
            requiredProperties.push('Value');
          }
          schemaDef.properties.Value = value;
          if (tbd) {
            schemaDef.properties.Value.description = def.value.text ? ('TBD: ' + def.value.text) : tbdValueToString(def.value);
          }
        }
      }
      if (def.fields.length) {
        const fieldNameMap = {};
        const clashingNames = {};
        for (const field of def.fields) {
          if (!(field instanceof TBD)) {
            if (!isValidField(field)) {
              continue;
            } else if (field.inheritance === INHERITED) {
              if (fieldNameMap[field.identifier.name]) {
                //duplicate number - reassigned
                //18001, 'Clashing property names: ${name1} and ${name2} ',  'Unknown' , 'errorNumber'
                logger.error({name1 : fieldNameMap[field.identifier.name].fqn, name2 : field.identifier.fqn}, '18001');
                clashingNames[field.identifier.name] = true;
              } else {
                fieldNameMap[field.identifier.name] = field.identifier;
              }
              continue;
            }

            if (fieldNameMap[field.identifier.name]) {
              //duplicate number - reassigned
              //18001, 'Clashing property names: ${name1} and ${name2} ',  'Unknown' , 'errorNumber'
              logger.error({name1 : fieldNameMap[field.identifier.name].fqn, name2 : field.identifier.fqn}, '18001');
              clashingNames[field.identifier.name] = true;
              continue;
            } else {
              fieldNameMap[field.identifier.name] = field.identifier;
            }
          }
          const card = field.effectiveCard;
          if (card && card.isZeroedOut) {
            continue;
          }
          let {value, required, tbd} = convertDefinition(field, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
          if (tbd) {
            tbdFieldDescriptions.push(tbdValueToString(field));
            continue;
          }

          schemaDef.properties[field.identifier.name] = value;
          if (required) {
            requiredProperties.push(field.identifier.name);
          }
        }

        for (const clashingName in clashingNames) {
          delete schemaDef.properties[clashingName];
        }
        requiredProperties = requiredProperties.filter(propName => !(propName in clashingNames));
      } else if (!def.value) {
        schemaDef.type = 'object';
        schemaDef.description = 'Empty DataElement?';
      }
      let descriptionList = [];
      if (def.description) {
        descriptionList.push(def.description);
      }
      if (def.concepts.length) {
        wholeDef.concepts = def.concepts.map((concept) => makeConceptEntry(concept));
      }
      if (tbdParentDescriptions.length) {
        tbdParentDescriptions[0] = 'TBD Parents: ' + tbdParentDescriptions[0];
        descriptionList = descriptionList.concat(tbdParentDescriptions);
      }
      if (tbdFieldDescriptions.length) {
        tbdFieldDescriptions[0] = 'TBD Fields: ' + tbdFieldDescriptions[0];
        descriptionList = descriptionList.concat(tbdFieldDescriptions);
      }
      if (descriptionList.length) {
        wholeDef.description = descriptionList.join('\n');
      }
      if (needsEntryType) {
        schemaDef.properties['entryType'] = nonEntryEntryTypeField;
        requiredProperties.push('entryType');
      }

      if (requiredProperties.length) {
        schemaDef.required = requiredProperties;
      }

      schema.definitions[def.identifier.name] = wholeDef;
      if (def.isEntry && (!def.isAbstract)) {
        entryRefs.push({ $ref: makeRef(def.identifier, ns, baseSchemaURL)});
      }
    } finally {
      logger = lastLogger;
    }
  }

  if (entryRefs.length) {
    schema.type = 'object';
    schema.anyOf = entryRefs;
  }
  return { schemaId, schema };
}

/**
 * Converts a namespace into a flat JSON Schema.
 * @param {Namespace} ns - the namespace of the schema.
 * @param {DataElementSpecifications} dataElementsSpecs - the elements in the namespace.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the entryType field.
 * @return {{schemaId: string, schema: Object}} The schema id and the JSON Schema definition.
 */
function flatNamespaceToSchema(ns, dataElementsSpecs, baseSchemaURL, baseTypeURL) {
  const dataElements = dataElementsSpecs.byNamespace(ns.namespace);
  const schemaId = `${baseSchemaURL}/${namespaceToURLPathSegment(ns.namespace)}`;
  let schema = {
    $schema: 'http://json-schema.org/draft-04/schema#',
    id: schemaId,
    title: 'TODO: Figure out what the title should be.',
    definitions: {}
  };
  const expandedEntry = makeExpandedEntryDefinitions(ns, baseSchemaURL);
  if (ns.description) {
    schema.description = ns.description;
  }

  const defs = dataElements.sort(function(l,r) {return l.identifier.name.localeCompare(r.identifier.name);});
  const entryRefs = [];
  for (const def of defs) {
    let schemaDef = {
      type: 'object',
      properties: {}
    };
    let wholeDef = schemaDef;
    const tbdParentDescriptions = [];
    let requiredProperties = [];
    if (def.isEntry) {
      requiredProperties = expandedEntry.required.slice();
    }

    const tbdFieldDescriptions = [];
    if (def.value) {
      let { value, required, tbd } = convertDefinition(def.value, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
      if (required) {
        requiredProperties.push('Value');
      }
      schemaDef.properties.Value = value;
      if (tbd) {
        schemaDef.properties.Value.description = def.value.text ? ('TBD: ' + def.value.text) : tbdValueToString(def.value);
      }
    }
    if (def.fields.length) {
      for (const field of def.fields) {
        if (!(field instanceof TBD) && !isValidField(field)) {
          continue;
        }
        const card = field.effectiveCard;
        if (card && card.isZeroedOut) {
          continue;
        }
        let {value, required, tbd} = convertDefinition(field, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
        if (tbd) {
          tbdFieldDescriptions.push(tbdValueToString(field));
          continue;
        }

        const fieldName = field.identifier.name;
        schemaDef.properties[fieldName] = value;
        if (required && (requiredProperties.indexOf(fieldName) === -1)) {
          requiredProperties.push(fieldName);
        }
      }
      if (def.isEntry) {
        for (const name in expandedEntry.properties) {
          if (!(name in schemaDef.properties)) {
            schemaDef.properties[name] = expandedEntry.properties[name];
          }
        }
      }
    } else if (!def.value) {
      schemaDef.type = 'object';
      schemaDef.description = 'Empty DataElement?';
    }
    let descriptionList = [];
    if (def.description) {
      descriptionList.push(def.description);
    }
    if (def.concepts.length) {
      wholeDef.concepts = def.concepts.map((concept) => makeConceptEntry(concept));
    }
    if (tbdParentDescriptions.length) {
      tbdParentDescriptions[0] = 'TBD Parents: ' + tbdParentDescriptions[0];
      descriptionList = descriptionList.concat(tbdParentDescriptions);
    }
    if (tbdFieldDescriptions.length) {
      tbdFieldDescriptions[0] = 'TBD Fields: ' + tbdFieldDescriptions[0];
      descriptionList = descriptionList.concat(tbdFieldDescriptions);
    }
    if (descriptionList.length) {
      wholeDef.description = descriptionList.join('\n');
    }
    if (requiredProperties.length) {
      schemaDef.required = requiredProperties;
    }

    schema.definitions[def.identifier.name] = wholeDef;
    if (def.isEntry && (!def.isAbstract)) {
      entryRefs.push({ $ref:  makeRef(def.identifier, ns, baseSchemaURL)});
    }
  }

  if (entryRefs.length) {
    schema.type = 'object';
    schema.anyOf = entryRefs;
  }
  return { schemaId, schema };
}

function namespaceToURLPathSegment(namespace) {
  return namespace.replace(/\./g, '/');
}

function isValidField(field) {
  if (field instanceof ChoiceValue) {
    //18002, 'Ignoring field defined as a choice: ${field1}',	  'Unknown' , 'errorNumber'
    logger.error({field1 : field.toString()}, '18002' );
    return false;
  }
  if (!(field.identifier)) {
    //18003, 'Ignoring name-less field: ${field1} ', 'Unknown' , 'errorNumber'
    logger.error({field1 : field.toString() },'18003' );
    return false;
  }
  if (field.identifier.name === 'Value') {
    //18004, 'Ignoring restricted field name: Value :  ${field1} ',  'Unknown' , 'errorNumber'
    logger.error({field1 : field.toString() }, '18004' );
    return false;
  }
  return true;
}

function convertDefinition(valueDef, dataElementsSpecs, enclosingNamespace, baseSchemaURL, baseTypeURL) {
  let listValue = null;
  let value = {};
  const fullDef = valueDef.identifier ? dataElementsSpecs.findByIdentifier(valueDef.identifier) : null;
  const card = valueDef.effectiveCard;
  let required = false;
  let isList = false;
  let valueIsPrimitive = false;
  if (card) {
    isList = card.isList;
    if (!isList && fullDef && fullDef.value) {
      const cardConstraints = fullDef.value.constraintsFilter.own.card.constraints;
      isList = cardConstraints.some((oneCard) => oneCard.isList);
    }
    if (isList) {
      listValue = { type: 'array' };
      if (card.min != null) {
        listValue.minItems = card.min;
        if (card.min) {
          required = true;
        }
      }
      if (card.max) {
        listValue.maxItems = card.max;
      }
      listValue.items = value;
    } else if (card.min) {
      required = true;
    }
  }

  if (valueDef instanceof ChoiceValue) {
    const refOptions = [];
    const normalOptions = [];
    for (const option of valueDef.options) {
      if (option.effectiveCard && (!option.effectiveCard.isExactlyOne)) {
        //18005, 'Choices with options with cardinalities that are not exactly one are illegal ${value1}. Ignoring option ${option1}' ,  'Unknown' , 'errorNumber'
        logger.error({value1 : valueDef.toString(), option1 : option.toString() },'18005' );
      } else if (isRef(option, dataElementsSpecs)) {
        refOptions.push(option);
      } else {
        normalOptions.push(option);
      }
    }
    value.anyOf = [];
    if (refOptions.length) {
      value.anyOf.push(makeShrRefObject(refOptions, baseTypeURL));
    }
    for (const option of normalOptions) {
      const { value: childValue } = convertDefinition(option, dataElementsSpecs, enclosingNamespace, baseSchemaURL, baseTypeURL);
      value.anyOf.push(childValue);
    }
    if (value.anyOf.length == 1) {
      const single = value.anyOf[0];
      delete value.anyOf;
      for (const ent in single) {
        value[ent] = single[ent];
      }
    }
  } else if (isRef(valueDef, dataElementsSpecs)) {
    // TODO: What should the value of entryType be? The schema URL may not be portable across data types.
    makeShrRefObject([valueDef], baseTypeURL, value);
  } else if (valueDef instanceof IdentifiableValue) {
    const id = valueDef.effectiveIdentifier;
    if (id.isPrimitive) {
      valueIsPrimitive = true;
      makePrimitiveObject(id, value);
    } else {
      const typeRef = makeRef(valueDef.identifier, enclosingNamespace, baseSchemaURL);
      if (valueDef.inheritance !== OVERRIDDEN) {
        value.allOf = [{ $ref: typeRef}];
      }
    }
  } else if (valueDef instanceof TBD) {
    let ret = value;
    if (listValue) {
      delete listValue.items;
      ret = listValue;
    }
    return {value: ret, required: required, tbd: true};
  } else if (valueDef instanceof IncompleteValue) {
    //18006, 'Unsupported Incomplete'	 , 'Unknown' , 'errorNumber'
    logger.error('18006');
  } else {
    //18007, 'Unknown type for value ${value1} ' , 'Unknown' , 'errorNumber'
    logger.error({value1 : valueDef.constructor.name},'18007');
  }

  const constraintStructure = { $self: []};
  const includesCodeLists = {};
  for (const constraint of valueDef.constraints) {
    let {path: constraintPath, target: constraintTarget } = extractConstraintPath(constraint, valueDef, dataElementsSpecs);
    if (!constraintPath) {
      continue;
    } else if (!constraintTarget) {
      // Cardinality constraints without a path are not useful (except if you're really a list, we'll handle that later).
      if (constraint instanceof CardConstraint) {
        continue;
      } else {
        constraintTarget = valueDef;
      }
    }

    let currentStruct = constraintStructure;
    for (const path of constraintPath) {
      if (!currentStruct[path]) {
        currentStruct[path] = { $self: []};
      }
      currentStruct = currentStruct[path];
    }
    currentStruct.$self.push({ constraint, constraintPath, constraintTarget });
  }

  let allOf = [{properties: {}}];
  if (Object.keys(value).length) {
    allOf.push(value);
  }
  function pruneExpandedStructure (currentAllOf) {
    for (let i = currentAllOf.length - 1; i >= 0; i -= 1) {
      const allOfEntry = currentAllOf[i];
      if (allOfEntry.constraints && (!allOfEntry.constraints.length)) {
        delete allOfEntry.constraints;
      }
      if (allOfEntry.properties) {
        if (!Object.keys(allOfEntry.properties).length) {
          delete allOfEntry.properties;
        } else {
          for (const path in allOfEntry.properties) {
            if (allOfEntry.properties[path].allOf) {
              pruneExpandedStructure(allOfEntry.properties[path].allOf);
              switch (allOfEntry.properties[path].allOf.length) {
              case 1:
                allOfEntry.properties[path] = allOfEntry.properties[path].allOf[0];
                break;
              case 0:
                delete allOfEntry.properties[path].allOf;
                break;
              }
            }
            if (!Object.keys(allOfEntry.properties[path]).length) {
              delete allOfEntry.properties[path];
            }
          }
          if (!Object.keys(allOfEntry.properties).length) {
            delete allOfEntry.properties;
          }
        }
      }
      if (allOfEntry.allOf && allOfEntry.allOf.length === 1) {
        for (const key in allOfEntry.allOf[0]) {
          if (key !== 'allOf') {
            allOfEntry[key] = allOfEntry.allOf[0][key];
          }
        }
        delete allOfEntry.allOf;
      }
      if (!Object.keys(allOfEntry).length) {
        currentAllOf.splice(i, 1);
      }
    }
  }

  function constraintDfs (node, currentAllOf, parentAllOf = null) {
    for (const path in node) {
      if (path !== '$self') {
        if (!currentAllOf[0].properties[path]) {
          currentAllOf[0].properties[path] = {
            allOf: [
              { properties: {} }
            ]
          };
        }
        constraintDfs(node[path], currentAllOf[0].properties[path].allOf, currentAllOf);
      } else {
        currentAllOf[0].constraints = [];
        let includesConstraints = null;
        let includesCodeConstraints = null;
        for (const constraintInfo of node.$self) {
          if (constraintInfo.constraint instanceof TypeConstraint) {
            if (isRef(constraintInfo.constraintTarget, dataElementsSpecs)) {
              const refid = constraintInfo.constraint.isA;
              if (isOrWasAList(constraintInfo.constraintTarget)) {
                currentAllOf.push({ items: { refType: [`${baseTypeURL}${namespaceToURLPathSegment(refid.namespace)}/${refid.name}`]}});
              } else {
                currentAllOf.push({ refType: [`${baseTypeURL}${namespaceToURLPathSegment(refid.namespace)}/${refid.name}`]});
              }
            } else if (constraintInfo.constraintTarget instanceof IdentifiableValue) {
              let schemaConstraint = null;
              if (constraintInfo.constraint.isA.isPrimitive) {
                schemaConstraint = makePrimitiveObject(constraintInfo.constraint.isA);
              } else {
                schemaConstraint = {$ref: makeRef(constraintInfo.constraint.isA, enclosingNamespace, baseSchemaURL)};
              }
              if (isOrWasAList(constraintInfo.constraintTarget)) {
                currentAllOf.push({ items: schemaConstraint });
              } else {
                currentAllOf.push(schemaConstraint);
              }
            } else {
              //18009, 'Internal error unexpected constraint target: ${target1} for constraint ${constraint1}'A , 'Unknown' , 'errorNumber'
              logger.error({target1 : constraintInfo.constraintTarget.toString(), constraint1 : constraintInfo.constraint.toString() },'18009' );
            }
          } else if (constraintInfo.constraint instanceof SubsetConstraint) {
            const anyOf = [];
            for (const option of constraintInfo.constraint.subsetList) {
              let schemaConstraint = null;
              if (option.isPrimitive) {
                schemaConstraint = makePrimitiveObject(option);
              } else {
                schemaConstraint = {$ref: makeRef(option, enclosingNamespace, baseSchemaURL)}
              }
              anyOf.push(schemaConstraint);
            }
            currentAllOf.push({ anyOf: anyOf });
          }
           else if (constraintInfo.constraint instanceof IncludesTypeConstraint) {
            if (!includesConstraints) {
              includesConstraints = {refs: [], types: [], min: 0, max: 0};
            }
            includesConstraints.min += constraintInfo.constraint.card.min;
            if (includesConstraints.max !== null) {
              if (constraintInfo.constraint.card.isMaxUnbounded) {
                includesConstraints.max = null;
              } else {
                includesConstraints.max += constraintInfo.constraint.card.max;
              }
            }

            if (isRef(constraintInfo.constraint.isA, dataElementsSpecs)) {
              includesConstraints.refs.push(constraintInfo.constraint);
            } else {
              includesConstraints.types.push(constraintInfo.constraint);
            }
          } else if (constraintInfo.constraint instanceof IncludesCodeConstraint) {
            if (!includesCodeConstraints) {
              includesCodeConstraints = [];
            }
            includesCodeConstraints.push(constraintInfo.constraint);
          } else if (constraintInfo.constraint instanceof ValueSetConstraint) {
            if (currentAllOf[0].valueSet) {
              //18010, 'Multiple valueset constraints found on a single element ${element1}'  , 'Unknown' , 'errorNumber'
              logger.error({element1 : constraintInfo.constraint },'18010' );
              continue;
            }
            currentAllOf[0].valueSet = {
              uri: constraintInfo.constraint.valueSet,
              strength: constraintInfo.constraint.bindingStrength
            };
          } else if (constraintInfo.constraint instanceof CodeConstraint) {
            // Maybe TODO: For entry elements this can have some level of enforcement by ANDing the exact contents of the entryType field with an enum for this value/field.
            if (currentAllOf[0].code) {
              //18011, Multiple code constraints found on a single element ${element1} '  ,  'Unknown' , 'errorNumber'
              logger.error({element1 : constraintInfo.constraint },'18011' );
              continue;
            }
            currentAllOf[0].code = makeCodingEntry(constraintInfo.constraint.code);
          } else if (constraintInfo.constraint instanceof BooleanConstraint) {
            currentAllOf.push({ enum: [constraintInfo.constraint.value]});
          } else if (constraintInfo.constraint instanceof FixedValueConstraint) {
            currentAllOf.push({ enum: [constraintInfo.constraint.value]});
          } else if (constraintInfo.constraint instanceof CardConstraint) {
            // TODO: 0..0
            if (isOrWasAList(constraintInfo.constraintTarget)) {
              const arrayDef = {
                type: 'array',
                minItems: constraintInfo.constraint.card.min,
              };
              if (constraintInfo.constraint.card.max) {
                arrayDef.maxItems = constraintInfo.constraint.card.max;
              }
              currentAllOf.push(arrayDef);
              if (parentAllOf && constraintInfo.constraint.card.min) {
                parentAllOf.push({ required: [constraintInfo.constraintPath[constraintInfo.constraintPath.length - 1]] });
              }
            } else {
              if (parentAllOf && constraintInfo.constraint.card.min) {
                parentAllOf.push({ required: [constraintInfo.constraintPath[constraintInfo.constraintPath.length - 1]] });
              }
            }
          } else {
            currentAllOf[0].constraints.push(constraintInfo.constraint);
          }
        }

        if (includesConstraints) {
          currentAllOf[0].includesTypes = [];
          const includesTypesArrayDef = {
            type: 'array',
            minItems: includesConstraints.min,
            items: { anyOf: [] }
          };
          currentAllOf.push(includesTypesArrayDef);
          if (includesConstraints.max !== null) {
            includesTypesArrayDef.maxItems = includesConstraints.max;
          }
          if (includesConstraints.refs.length) {
            includesTypesArrayDef.items.anyOf.push(makeShrRefObject(includesConstraints.refs.map((ref) => ref.isA), baseTypeURL));
            for (const ref of includesConstraints.refs) {
              const includesType = {
                items: `ref(${makeShrDefinitionURL(ref.isA, baseSchemaURL)})`,
                minItems: ref.card.min
              };
              if (!ref.card.isMaxUnbounded) {
                includesType.maxItems = ref.card.max;
              }
              currentAllOf[0].includesTypes.push(includesType);
            }
          }
          for (const val of includesConstraints.types) {
            includesTypesArrayDef.items.anyOf.push({ $ref: makeRef(val.isA, enclosingNamespace, baseSchemaURL) });
            const includesType = {
              items: `${baseTypeURL}${namespaceToURLPathSegment(val.isA.namespace)}/${val.isA.name}`,
              minItems: val.card.min
            };
            if (!val.card.isMaxUnbounded) {
              includesType.maxItems = val.card.max;
            }
            currentAllOf[0].includesTypes.push(includesType);
          }
        }
        if (includesCodeConstraints) {
          currentAllOf[0].includesCodes = includesCodeConstraints.map((it) => makeCodingEntry(it.code));
        }
      }
    }
  }

  if (valueDef.constraints && valueDef.constraints.length) {
    constraintDfs(constraintStructure, allOf);
    if (isList) {
      for (const includesConstraintDef of allOf) {
        if (includesConstraintDef.type === 'array') {
          if ((listValue.minItems !== null) && (listValue.minItems !== undefined)) {
            listValue.minItems = Math.max(listValue.minItems, includesConstraintDef.minItems);
          } else {
            listValue.minItems = includesConstraintDef.minItems;
          }
          // TODO: Support 0..0
          if (listValue.maxItems == null) {
            listValue.maxItems = includesConstraintDef.maxItems;
          } else {
            if (includesConstraintDef.maxItems != null) {
              listValue.maxItems = Math.min( listValue.maxItems, includesConstraintDef.maxItems);
            }
          }
          listValue.includesTypes = allOf[0].includesTypes;
          delete allOf[0].includesTypes;

          allOf.push(includesConstraintDef.items);
          delete includesConstraintDef.items;
          delete includesConstraintDef.maxItems;
          delete includesConstraintDef.minItems;
          delete includesConstraintDef.type;
          break;
        }
      }
    }

    if (valueIsPrimitive) {
      pruneExpandedStructure(allOf);
      if (value !== allOf[0]) {
        for (const prop in allOf[0]) {
          value[prop] = allOf[0][prop];
          delete allOf[0][prop];
        }
      }
    }
  }
  pruneExpandedStructure(allOf);
  function sanityCheckFinalStructure (currentAllOf) {
    for (let i = currentAllOf.length - 1; i >= 0; i -= 1) {
      const allOfEntry = currentAllOf[i];
      if (allOfEntry.constraints) {
        for (const constraint of allOfEntry.constraints) {
          //18012, 'Internal error: unhandled constraint ${constraint1} ' , 'Unknown' , 'errorNumber'
          logger.error({constraint1 : constraint.toString() },'18012' );
        }
      }
      if (allOfEntry.properties) {
        for (const path in allOfEntry.properties) {
          if (allOfEntry.properties[path].allOf) {
            sanityCheckFinalStructure(allOfEntry.properties[path].allOf);
          } else {
            sanityCheckFinalStructure([allOfEntry.properties[path]]);
          }
        }
      }
    }
  }
  sanityCheckFinalStructure(allOf);

  if (allOf.length) {
    const allOfDef = allOf.length === 1 ? allOf[0] : { allOf: allOf };
    if (listValue) {
      listValue.items = allOfDef;
    } else {
      value = allOfDef;
    }
  }

  if (Object.keys(includesCodeLists).length) {
    value.codes = includesCodeLists;
  }

  return {value: listValue ? listValue : value, required, tbd: false};
}

function tbdValueToString(tbd) {
  if (tbd.text) {
    return tbd.text;
  } else {
    const card = tbd.effectiveCard;
    if (card) {
      return 'TBD with cardinality ' + card;
    } else {
      return 'TBD';
    }
  }
}

function isRef(value, dataElementsSpecs) {
  if (value && value.effectiveIdentifier) {
    const de = dataElementsSpecs.findByIdentifier(value.effectiveIdentifier);
    return de && de.isEntry;
  }
  return false;
}

/**
 * Create a JSON Schema reference to the specified type.
 *
 * @param {Identifier} id - the target type.
 * @param {Namespace} enclosingNamespace - the current namespace that is being evaluated.
 * @param {string} baseSchemaURL - the root URL for the schema identifier
 * @returns {string} - a JSON Schema reference to the target type.
 */
function makeRef(id, enclosingNamespace, baseSchemaURL) {
  if (id.namespace === enclosingNamespace.namespace) {
    return '#/definitions/' + id.name;
  } else {
    return makeShrDefinitionURL(id, baseSchemaURL);
  }
}

function makeShrRefObject(refs, baseTypeURL, target = {}) {
  target.type = 'object';
  target.properties = {
    _ShrId: { type: 'string' },
    _EntryId: { type: 'string' },
    _EntryType: { type: 'string' }
  };
  target.required = ['_ShrId', '_EntryType', '_EntryId'];
  target.refType = refs.map((ref) => `${baseTypeURL}${namespaceToURLPathSegment(ref.identifier.namespace)}/${ref.identifier.name}`);
  return target;
}

function makeShrDefinitionURL(id, baseSchemaURL) {
  return `${baseSchemaURL}/${namespaceToURLPathSegment(id.namespace)}#/definitions/${id.name}`;
}

function makePrimitiveObject(id, target = {}) {
  switch (id.name) {
  case 'boolean':
  case 'string':
  case 'integer':
    target.type = id.name;
    break;
  case 'unsignedInt':
    target.type = 'integer';
    target.minimum = 0;
    break;
  case 'positiveInt':
    target.type = 'integer';
    target.minimum = 1;
    break;
  case 'decimal':
    target.type = 'number';
    break;
  case 'uri':
    target.type = 'string';
    target.format = 'uri';
    break;
  case 'base64Binary':
    target.type = 'string';
    break;
  case 'dateTime':
    target.type = 'string';
    target.format = 'date-time';
    break;
  case 'instant':
  case 'date':
  case 'time':
    target.type = 'string';
    break;
  case 'concept':
    target['$ref'] = 'https://standardhealthrecord.org/schema/cimpl/builtin#/definitions/Concept';
    break;
  case 'oid':
  case 'id':
  case 'markdown':
  case 'xhtml':
    target.type = 'string';
    break;
  }

  return target;
}

/**
 * Translates a constraint path into a valid path for the JSON Schema.
 * @param {Constraint} constraint - the constraint.
 * @param {IdentifiableValue} valueDef - the identifiable value that contains the constraint.
 * @param {DataElementSpecifications} dataElementSpecs - the elements in the namespace.
 * @return {{path: (Array<string>|undefined), target: (Value|undefined)}} - The target of the constraint and the extracted path (qualified if necessary). Both properties will be null if there was an error.
 */
function extractConstraintPath(constraint, valueDef, dataElementSpecs) {
  if (constraint.onValue) {
    return extractUnnormalizedConstraintPath(constraint, valueDef, dataElementSpecs);
  } else if (constraint.path.length > 0 && constraint.path[constraint.path.length-1].isValueKeyWord) {
    // Essentially the same as above, when onValue is never checked again, so just chop it off
    // treat it like above.  TODO: Determine if this is really the right approach.
    const simpleConstraint = constraint.clone();
    simpleConstraint.path = simpleConstraint.path.slice(0, simpleConstraint.path.length-1);
    return extractUnnormalizedConstraintPath(simpleConstraint, valueDef, dataElementSpecs);
  }

  if (!constraint.hasPath()) {
    return { path: [] };
  }

  let currentDef = dataElementSpecs.findByIdentifier(valueDef.effectiveIdentifier);
  const normalizedPath = [];
  let target = null;
  for (let i = 0; i < constraint.path.length; i += 1) {
    const pathId = constraint.path[i];
    target = null;
    if (pathId.namespace === PRIMITIVE_NS) {
      if (i !== constraint.path.length - 1) {
        //18013, 'Encountered a constraint path containing a primitive ${pathId1} at index ${index1} that was not the leaf: ${constraint1} ' , 'Unknown' , 'errorNumber'
        logger.error({pathId1 : pathId , index1 : i, constraint1 : constraint.toString() }, '18013' );
        return {};
      }
      if (!currentDef.value) {
        //18014, 'Encountered a constraint path with a primitive leaf ${pathId1} on an element that lacked a value: ${constraint1} '  , 'Unknown' , 'errorNumber'
        logger.error({pathId1 : pathId, constraint1 : constraint.toString() },'18014' );
        return {};
      }
      if (currentDef.value instanceof ChoiceValue) {
        target = findOptionInChoice(currentDef.value, pathId, dataElementSpecs);
        if (!target) {
          //18015, 'Encountered a constraint path with a primitive leaf ${pathId1} on an element with a mismatched value: ${constraint1} on valueDef ${valueDef1} ' , 'Unknown' , 'errorNumber'
          logger.error({pathId1 : pathId, constraint1 : constraint.toString(), valueDef1 : valueDef.toString() },'18015' );
          return {};
        }
      } else if (!pathId.equals(currentDef.value.identifier)) {
        //18016, 'Encountered a constraint path with a primitive leaf ${pathId1} on an element with a mismatched value: ${constraint1} on valueDef ${valueDef1} ' , 'Unknown' , 'errorNumber'
        logger.error({pathId1 : pathId, constraint1: constraint.toString(), valueDef1: valueDef.toString()}, '18016' );
        return {};
      } else {
        target = currentDef.value;
      }
      normalizedPath.push('Value');
    } else {
      const newDef = dataElementSpecs.findByIdentifier(pathId);
      if (!newDef) {
        // duplicate error number; remapped
        //18017, 'Cannot resolve element definition for ${pathId1} on constraint ${constraint1}. ' , 'Unknown' , 'errorNumber'
        logger.error({pathId1 : pathId, constraint1 : constraint.toString() },'18017' );
        return {};
      }
      // See if the current definition has a value of the specified type.
      if (currentDef.value) {
        if (currentDef.value instanceof ChoiceValue) {
          target = findOptionInChoice(currentDef.value, pathId, dataElementSpecs);
        } else if (pathId.equals(currentDef.value.identifier) || checkHasBaseType(currentDef.value.identifier, pathId, dataElementSpecs)) {
          target = currentDef.value;
          normalizedPath.push('Value');
        }
      }

      if (!target) {
        if (!currentDef.fields || !currentDef.fields.length) {
          //18018, 'Element ${element1} lacked any fields or a value that matched ${pathId1} as part of constraint ${constraint1} ' , 'Unknown' , 'errorNumber'
          logger.error({element1 : currentDef.identifier.fqn, pathId1 : pathId, constraint1 : constraint.toString() }, '18018' );
          return {};
        } else {
          target = currentDef.fields.find((field) => pathId.equals(field.identifier));
          if (!target) {
            // It's possible that the field is actually defined as an "includes type" constraint on a list.
            // In this case, do nothing, because right now there isn't a valid way to represent further constraints
            // on includesType elements in the schema.
            if (valueDef.constraintsFilter.includesType.constraints.some(c => c.isA.equals(pathId))) {
              // 08004, 'Cannot enforce constraint ${constraint} on Element ${elementFqn} since ${path} refers to a type introduced by an "includesType" constraint'
              logger.warn({ constraint: constraint.toString(), elementFqn: currentDef.identifier.fqn, path: pathId.toString() }, '08004');
            } else {
              //18019, 'Element ${element1} lacked a field or a value that matched ${pathId1} as part of constraint ${constraint1} ' , 'Unknown' , 'errorNumber'
              logger.error({element1 : currentDef.identifier.fqn, pathId1 : pathId, constraint1 : constraint.toString() },'18019' );
            }
            return {};
          }
          normalizedPath.push(pathId.name);
        }
      }
      currentDef = newDef;
    }
  }

  return {path:normalizedPath, target};
}

function extractUnnormalizedConstraintPath(constraint, valueDef, dataElementSpecs) {
  let currentDef = dataElementSpecs.findByIdentifier(valueDef.effectiveIdentifier);
  const normalizedPath = [];
  const len = constraint.hasPath() ? constraint.path.length : 0;
  for (let i = 0; i < len; i += 1) {
    const pathId = constraint.path[i];
    if (pathId.namespace === PRIMITIVE_NS) {
      //18020, 'Encountered an unnormalized constraint path containing a primitive ${pathId1} at index ${index1}: ${constraint1} '  , 'Unknown' , 'errorNumber'
      logger.error({pathId1 : pathId, index1 : i ,  constraint1 : constraint.toString() },'18020' );
      return {};
    }
    const newDef = dataElementSpecs.findByIdentifier(pathId);
    if (!newDef) {
      //remapped error numnber
      //18017, 'Cannot resolve element definition for ${pathId1} on constraint ${constraint1}. ' , 'Unknown' , 'errorNumber'
      logger.error({pathId1 :  pathId, constraint1 : constraint.toString() },'18017' );
      return {};
    }
    let found = false;
    // See if the current definition has a value of the specified type.
    if (currentDef.value) {
      if (currentDef.value instanceof ChoiceValue) {
        for (const choice of currentDef.value.aggregateOptions) {
          if (pathId.equals(choice.identifier) || checkHasBaseType(choice.identifier, pathId, dataElementSpecs)) {
            found = true;
            break;
          }
        }
      } else if (pathId.equals(currentDef.value.identifier) || checkHasBaseType(currentDef.value.identifier, pathId, dataElementSpecs)) {
        normalizedPath.push('Value');
        found = true;
      }
    }

    if (!found) {
      if (!currentDef.fields || !currentDef.fields.length) {
        //18021,  'Element ${element1} lacked any fields or a value that matched ${pathId1} as part of constraint ${constraint1} '  , 'Unknown' , 'errorNumber'
        logger.error({element1 : currentDef.identifier.fqn,  pathId1 : pathId, constraint1 : constraint.toString()}, '18021' );
        return {};
      } else {
        const found = currentDef.fields.some((field) => pathId.equals(field.identifier));
        if (!found) {
          // It's possible that the field is actually defined as an "includes type" constraint on a list.
          // In this case, do nothing, because right now there isn't a valid way to represent includesType
          // constraints in the schema.
          if (valueDef.constraintsFilter.includesType.constraints.some(c => c.isA.equals(pathId))) {
            // TODO: Eventually, somehow, support includesType constraints
          } else {
            //18021,  'Element ${element1} lacked any fields or a value that matched ${pathId1} as part of constraint ${constraint1} '  , 'Unknown' , 'errorNumber'
            logger.error({element1 : currentDef.identifier.fqn,  pathId1 : pathId, constraint1 : constraint.toString()}, '18021' );
          }
          return {};
        }
        normalizedPath.push(pathId.name);
      }
    }
    currentDef = newDef;
  }

  if (!currentDef.value) {
    //18022, 'Target of an unnormalized constraint: ${target1} does not have a value. Constraint is: ${constraint1} ' , 'Unknown' , 'errorNumber'
    logger.error({target1 : currentDef.identifier.fqn, constraint1 : constraint.toString() },'18022' );
    return {};
  } else if (!(currentDef.value instanceof ChoiceValue)) {
    //18023, 'Constraint should not be on the value (except for choices): ${target1} in an expanded object model ${constraint1}. Ignoring constraint.',  , 'Unknown' , 'errorNumber'
    logger.error({target1 : currentDef.identifier.fqn, constraint1 : constraint.toString() },'18023' );
    return {};
  }
  let target = currentDef.value;
  if ((constraint instanceof TypeConstraint) || (constraint instanceof IncludesTypeConstraint)) {
    target = findOptionInChoice(currentDef.value, constraint.isA, dataElementSpecs);
    if (!target) {
      //18024, 'Target of an unnormalized constraint: ${constraint1} was a choice value that did not have a valid option: ${identifier1} ' , 'Unknown' , 'errorNumber'
      logger.error({constraint1 : constraint.toString(), identifier1 : currentDef.identifier.fqn },'18024' );
      return {};
    }
  }

  normalizedPath.push('Value');

  return {path:normalizedPath, target};
}

function makeExpandedEntryDefinitions(enclosingNamespace, baseSchemaURL) {
  const properties = {
    shrId: { type: 'string' },
    entryId: { type: 'string' },
    entryType: { type: 'string', format: 'uri' }
  };
  return { properties, required: [
    'shrId',
    'entryId',
    'entryType'
  ]};
}

/**
 * Converts a DataElement concept into a code entry for the schema. (Codes are also represented as Concepts in the object model.)
 *
 * @param {Concept|TBD} concept - The concept to convert.
 * @return {{coding: List<{code: string, system: string, display: (string|undefined)}>}} The converted object. Display is optional.
 */
function makeConceptEntry(concept) {
  return { coding: [ makeCodingEntry(concept) ]};
}

/**
 * Converts a concept into a coding entry for the schema (used in code constraints and includes code constraints)
 *
 * @param {Concept|TBD} concept - The concept to convert.
 * @return {{code: string, system: string, display: (string|undefined)}} The converted object. Display is optional.
 */
function makeCodingEntry(concept) {
  if (concept instanceof TBD) {
    const ret = { code: 'TBD', system: 'urn:tbd' };
    if (concept.text) {
      ret.display = concept.text;
    }
    return ret;
  } else {
    const ret = { code: concept.code, system: concept.system };
    if (concept.display) {
      ret.display = concept.display;
    }
    return ret;
  }
}

/**
 * Determine if a value or one of its ancestors is or was a list.
 *
 * @param {Value} value - the value to test.
 * @return {boolean} True if the value or any of its ancestors ever had a cardinality greater than 1.
 */
function isOrWasAList(value) {
  if (value.card.isList) {
    return true;
  }
  const cardConstraints = value.constraintsFilter.own.card.constraints;
  return cardConstraints.some((oneCard) => oneCard.isList);
}

/**
 * Searches the aggregate options of a choice for the specified option.
 *
 * @param {ChoiceValue} choice - the choice to evaluate.
 * @param {Identifier} optionId - the identifier to find in the choice.
 * @param {DataElementSpecifications} dataElementSpecs - The available DataElement specs.
 * @returns {Value?} The first option in the choice that matches the specified optionId.
 */
function findOptionInChoice(choice, optionId, dataElementSpecs) {
  // First look for a direct match
  for (const option of choice.aggregateOptions) {
    if (optionId.equals(option.identifier)) {
      return option;
    }
  }
  // Then look for a match on one of the selected options's base types
  // E.g., if choice has Quantity but selected option is IntegerQuantity
  for (const option of choice.aggregateOptions) {
    if (checkHasBaseType(optionId, option.identifier, dataElementSpecs)) {
      return option;
    }
  }
  return null;
}

function checkHasBaseType(identifier, baseIdentifier, dataElementSpecs) {
  if (typeof identifier === 'undefined' || typeof baseIdentifier === 'undefined') {
    return false;
  }
  const basedOns = getRecursiveBasedOns(identifier, dataElementSpecs);
  return basedOns.some(id => id.equals(baseIdentifier));
}

function getRecursiveBasedOns(identifier, dataElementSpecs, alreadyProcessed = []) {
  // If it's primitive or we've already processed this one, don't go further (avoid circular dependencies)
  if (identifier.isPrimitive || alreadyProcessed.some(id => id.equals(identifier))) {
    return alreadyProcessed;
  }

  // We haven't processed it, so look it up
  const element = dataElementSpecs.findByIdentifier(identifier);
  if (typeof element === 'undefined') {
    //18025 , 'Cannot resolve element definition for ${name1}' , 'This is due to a incomplete definition for an element. Please refer to the document for proper definition syntax.', 'errorNumber'
    logger.error({name1 : identifier.fqn },'18025');
    return alreadyProcessed;
  }
  // Add it to the already processed list (again, to avoid circular dependencies)
  alreadyProcessed.push(identifier);
  // Now recursively get the BasedOns for each of the BasedOns
  for (const basedOn of element.basedOn) {
    alreadyProcessed = getRecursiveBasedOns(basedOn, dataElementSpecs, alreadyProcessed);
  }

  return alreadyProcessed;
}
// done stealing from shr-expand

function errorFilePath() {
  return require('path').join(__dirname, '..', 'errorMessages.txt');
}

module.exports = {exportToJSONSchema, setLogger, MODELS_INFO, errorFilePath };
