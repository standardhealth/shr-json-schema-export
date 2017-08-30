// export SHR specification content as a hierarchy in JSON format
// Author: John Gibson
// Derived from export SHR specification content as a hierarchy in JSON format by Greg Quinn

const bunyan = require('bunyan');
const {IdentifiableValue, RefValue, ChoiceValue, TBD, IncompleteValue, ValueSetConstraint, IncludesCodeConstraint, CodeConstraint, CardConstraint, TypeConstraint} = require('shr-models');

var rootLogger = bunyan.createLogger({name: 'shr-json-schema-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}


function exportToJSONSchema(specifications) {
  const namespaceResults = [];
  for (const ns of specifications.namespaces.all) {
    namespaceResults.push(
        namespaceToSchema(ns,
            specifications.dataElements.byNamespace(ns.namespace),
            specifications.dataElements.grammarVersions )); // *Namespace
  }

  return namespaceResults;
}

function namespaceToSchema(ns, dataElements, grammarVersions) {
  let schema = {
    "$schema": "http://json-schema.org/draft-04/schema#",
    "id": "https://standardhealthrecord.org/test/" + ns.namespace.replace(/\./g, '/'),
    "title": "TODO: Figure out what the title should be.",
    "definitions": {}
  };

  const defs = dataElements.sort(function(l,r) {return l.identifier.name.localeCompare(r.identifier.name);});
  for (const def of defs) {
    let schemaDef = {
      type: 'object',
      properties: {}
    };

    let requiredProperties = [];
    if (def.value) {
      let {value, required} = convertDefinition(def.value, ns);
      if (!required) {
        logger.error('Internal error: Value was not required?', required);
      }
      requiredProperties.push('Value');
      schemaDef.properties.Value = value;
    }
    if (def.fields.length) {
      for (const field of def.fields) {
        if (field.constructor.name === 'ChoiceValue') {
          logger.error('ERROR: Ignoring field defined as a choice', field);
          continue;
        }
        if (field.identifier.name === 'Value') {
          logger.error('ERROR: Ignoring restricted field name: Value', field);
          continue;
        }
        const card = field.effectiveCard;
        if (card.isZeroedOut) {
          continue;
        }
        let {value, required} = convertDefinition(field, ns);
        schemaDef.properties[field.identifier.name] = value;
        if (required) {
          requiredProperties.push(field.identifier.name);
        }
      }
    } else if (!def.value) {
      schemaDef.type = 'object';
      schemaDef.description = 'Empty DataElement?';
    }
    schemaDef.description = def.description;
    if (def.concepts.length) {
      schemaDef.description += '\nConcepts: ' + def.concepts.map((c) => { return conceptToString(c); }).join(',');
    }
    if (requiredProperties.length) {
      schemaDef.required = requiredProperties;
    }

    schema.definitions[def.identifier.name] = schemaDef;
  }

  return schema;
}

function convertDefinition(valueDef, enclosingNamespace) {
  const retValue = {};
  let value = retValue;
  const card = valueDef.effectiveCard;
  let required = false;
  let isCode = false;
  if (card.isList) {
    retValue.type = 'array';
    if (card.min) {
      retValue.minItems = card.min;
      required = true;
    }
    if (card.max) {
      retValue.maxItems = card.max;
    }
    value = retValue.items = {};
  } else if (card.min) {
    required = true;
  }

  // TODO: Is this really the best way to identify a type in ES6?
  logger.debug('Value type: %s', valueDef.constructor.name);
  if (valueDef.constructor.name === 'ChoiceValue') {
    value.oneOf = [];
    for (const option of valueDef.options) {
      const { value: childValue } = convertDefinition(option, enclosingNamespace);
      value.oneOf.push(childValue);
    }
  } else if (valueDef.constructor.name === 'RefValue') {
    // TODO: Schema extension or base definition: make this a first-class object.
    value.type = 'object';
    value.properties = {
      ShrId: { type: 'string' },
      EntryType: { type: 'string', format: 'uri' },
      EntryId: { type: 'string' }
    };
    value.required = ['ShrId', 'EntryType', 'EntryId'];
  } else if (valueDef.constructor.name === 'IdentifiableValue') {
    const id = valueDef.effectiveIdentifier;
    if (id.isPrimitive) {
      switch (id.name) {
        case 'boolean':
        case 'string':
        case 'integer':
          value.type = id.name;
          break;
        case 'unsignedInt':
          value.type = 'integer';
          value.minimum = 0;
          break;
        case 'positiveInt':
          value.type = 'integer';
          value.minimum = 1;
          break;
        case 'decimal':
          value.type = 'number';
          break;
        case 'uri':
          value.type = 'string';
          value.format = 'uri';
          break;
        case 'base64Binary':
          value.type = 'string';
          break;
        case 'dateTime':
          value.type = 'string';
          value.format = 'dateTime';
          break;
        case 'instant':
        case 'date':
        case 'time':
        case 'code':
          value.type = 'string';
          isCode = true;
          break;
        case 'oid':
        case 'id':
        case 'markdown':
        case 'xhtml':
          value.type = 'string';
          break;
      }
    } else {
      if (id.namespace === enclosingNamespace.namespace) {
        value['$ref'] = '#' + valueDef.identifier.name;
      } else {
        value['$ref'] = "https://standardhealthrecord.org/test/" + valueDef.identifier.namespace.replace(/\./g, '/') + '#definitions/' + valueDef.identifier.name;
      }
    }
  } else if (valueDef.constructor.name === 'TBD') {
    logger.error('Unsupported TBD');
  } else if (valueDef.constructor.name === 'IncompleteValue') {
    logger.error('Unsupported Incomplete');
  } else {
    logger.error('Unknown type for value "%s"', valueDef.constructor.name);
  }

  const description = [];
  for (const constraint of valueDef.constraints) {
    if (constraint instanceof ValueSetConstraint) {
      if (!isCode) {
        logger.error('ERROR: valueset constraint %s was applied to a non-coding type %s', valueDef, constraint);
        continue;
      }
      description.push('ValueSet: ' + constraint.valueSet + ', ' + constraint.bindingStrength);
    } else if (constraint instanceof CodeConstraint) {
      if (!isCode) {
        logger.error('ERROR: code constraint %s was applied to a non-coding type %s', valueDef, constraint);
        continue;
      }
      description.push('Code: ' + constraint.code);
    } else if (constraint instanceof IncludesCodeConstraint) {
      if (!(isCode && card.isList)) {
        logger.error('ERROR: includes code constraint %s was applied to a non-coding array type %s', valueDef, constraint);
        continue;
      }
      description.push('Includes Code: ' + constraint.code);
    } else {
      logger.info('WARNING: Constraint not yet implemented', constraint);
    }
  }

  if (description.length) {
    retValue.description = 'Constraints: ' + description.join('\n');
  }

  return {value: retValue, required};
}

function conceptToString(concept) {
  if (concept.display) {
    return `${concept.display} (${concept.system}:${concept.code})`;
  } else {
    return `${concept.system}:${concept.code}`;
  }
}

function identifierToString(identifier) {
  return `${identifier.namespace}:${identifier.name}`;
}

module.exports = {exportToJSONSchema, setLogger};