/**
 * @module
 * @name WtCrudStrategies
 * @author Massimiliano Izzo
 * @description this handler works as a context for the transaction strategy
 *
 */
/*jshint node: true */
/*jshint esnext: true */
"use strict";

let _ = require("lodash");
const DataTypeClasses = require("../Utils").DataTypeClasses;
const FieldTypes = require("../Utils.js").FieldTypes;
let determineTableByModel = require("../Utils.js").determineTableByModel;
let allowedComparators = require("../Utils.js").allowedComparators;
let specializedProperties = require("../Utils.js").specializedProperties;
let pdProperties = require("../Utils.js").pdProperties;

let queryOutput = {
    lastPosition: 0,
    cteCount: 0,
    parameters: []
};

let fieldsForMainQueryMap = new Map([
    [DataTypeClasses.SUBJECT, "d.code, d.sex, "],
    [DataTypeClasses.SAMPLE, "d.biobank, d.biobank_code, "],
    [DataTypeClasses.DATA, ""]
]);

let fieldsForSubqueriesMap = new Map([
    [DataTypeClasses.SUBJECT, "id, code, sex"],
    [DataTypeClasses.SAMPLE, "id, biobank_code, parent_subject, parent_sample"],
    [DataTypeClasses.DATA, "id, parent_subject, parent_sample, parent_data"],
    [undefined, "id, parent_subject, parent_sample, parent_data"]  // default to DATA
]);

String.prototype.toUnderscore = function(){
    return this.replace(/([A-Z])/g, function($1){return "_"+$1.toLowerCase();});
};

/**
 * @class
 * @name WtQueryStrategy
 */
class WtQueryStrategy {

    /**
     * @abstract
     * @method
     * @name compose
     * @param{Object} criteria - the criteria object
     */
    compose(criteria) {
        throw new Error("Abstract method. Not implemented.");
    }

}

/**
 * @class
 * @name WtJSONQueryStrategy
 * @extends WtQueryStrategy
 */
class WtJSONQueryStrategy extends WtQueryStrategy {

    /**
     * @method
     * @name getSubqueryRow
     * @param{Object} element - a leaf in the query criteria object. It must contain the following fields:
     *                          1) fieldName
     *                          2) fieldType [TEXT, INTEGER, FLOAT, DATE, BOOLEAN]
     *                          2) comparator
     *                          3) fieldValue
     *                          4) fieldUnit [optional]
     *  @param{Object} previousOutput
     *  @param{String} tablePrefix
     */
    getSubqueryRow(element, previousOutput, tablePrefix) {
        if (_.isEmpty(element)) {
            return null;
        }
        if (allowedComparators.indexOf(element.comparator) < 0) {
            console.log(element.comparator);
            throw new Error("Operation not allowed. Trying to inject a forbidden comparator!!");
        }
        let nameParam = '$'+(++previousOutput.lastPosition), valueParam, subquery;
        if (element.isList) {
            let values = [];
            for (let i=0; i<element.fieldValue.length; i++) {
                values.push('$'+(++previousOutput.lastPosition));
            }
            console.log(values);
            valueParam = values.join();
            subquery = "(" + tablePrefix + "metadata->" + nameParam + "->>'value')::" + element.fieldType.toLowerCase()  +
                " " + element.comparator + " (" + valueParam  + ")";
        }
        else {
            valueParam = '$'+(++previousOutput.lastPosition);
            subquery = "(" + tablePrefix + "metadata->" + nameParam + "->>'value')::" + element.fieldType.toLowerCase()  +
                " " + element.comparator + " " + valueParam;
        }
        previousOutput.parameters.push(element.fieldName, element.fieldValue);
        if (element.fieldUnit) {
            let unitParam = '$'+(++previousOutput.lastPosition);
            subquery += " AND ";
            subquery += "(" + tablePrefix + "metadata->" + nameParam + "->>'unit')::text LIKE " + unitParam;
            previousOutput.parameters.push(element.fieldUnit);
        }
        // flatten nested arrays in parameters
        previousOutput.parameters = _.flatten(previousOutput.parameters);
        return {subquery: subquery};
    }

    /**
     * @method
     * @name composeSpecializedQuery
     * @description compose the part of the query relative to the specialized Model (Model here is intended in the sails.js sense)
     * @return {Object} - the query for the specialized parameters
     */
    composeSpecializedQuery(criteria, previousOutput, tablePrefix) {
        let lastParameterPosition = previousOutput.lastPosition || 0;
        previousOutput.parameters = previousOutput.parameters || [];
        let dataTypeClass = criteria.specializedQuery;
        tablePrefix = tablePrefix || ''; //'d.';
        let query = {}, clauses = [], comparator;
        specializedProperties[dataTypeClass].forEach(function(property) {
            if (criteria[property]) {
                if (_.isArray(criteria[property])) { // if it is a list of options (like in sex)
                    comparator = allowedComparators.indexOf(criteria[property+"Comparator"]) >= 0 ? criteria[property+"Comparator"] : 'IN';
                    let values = [];
                    for (let i=0; i<criteria[property].length; i++) {
                        values.push('$'+(++lastParameterPosition));
                    }
                    clauses.push(tablePrefix + property.toUnderscore() + " " + comparator + " (" + values.join() + ")");
                }
                else {
                    comparator = allowedComparators.indexOf(criteria[property+"Comparator"]) >= 0 ? criteria[property+"Comparator"] : '=';
                    clauses.push(tablePrefix + property.toUnderscore() + " " + comparator + " $" + (++lastParameterPosition));
                }
                previousOutput.parameters.push(criteria[property]);
            }
        });
        if (clauses.length) {
            query.subquery = clauses.join(" AND "); // TODO add possibility to switch and/or
        }
        query.lastParameterPosition = lastParameterPosition;
        query.parameters = _.flatten(previousOutput.parameters);
        return query;
    }

    /**
     * @method
     * @name composeSpecializedPersonalDetailsQuery
     * @description compose the part of a query pertaining to the personal_details table (personal data)
     * @return {Object}
     */
    composeSpecializedPersonalDetailsQuery(pdCriteria, previousOutput) {
        if (!previousOutput) {
            previousOutput = {
                lastPosition: 0,
                cteCount: 0,
                parameters: []
            };
        }
        let query = { alias: 'pd'};
        query.select = "SELECT id, given_name, surname, birth_date FROM personal_details";
        query.where = "";
        let whereClauses = []; // comparator;

        pdProperties.forEach(function(property) {
            if (pdCriteria[property]) {
                let comparator = allowedComparators.indexOf(pdCriteria[property+"Comparator"]) >= 0 ? pdCriteria[property+"Comparator"] : '=';
                whereClauses.push(query.alias + "." + property.toUnderscore() + " " + comparator + " $" + (++previousOutput.lastPosition));
                let value = ['givenName', 'surname'].indexOf(property) > -1 ? pdCriteria[property].toUpperCase() : pdCriteria[property];
                previousOutput.parameters.push(value);
            }
        });
        if (whereClauses.length) {
            // query.where = "WHERE " + whereClauses.join(" AND ");
            query.subquery = whereClauses.join(" AND ");
        }
        query.previousOutput = previousOutput;
        return query;
    }


    /**
     * @method
     * @name composeSingle
     * @description composes a query based on a single DataType
     */
    composeSingle(criteria, previousOutput, query) { // should I pass the parent params??
        if (!previousOutput) {
            previousOutput = {
                lastPosition: 0,
                cteCount: 0,
                parameters: []
            };
        }
        if (!query) {
            query= {};
        }
        query.subqueries = [];
        query.table = determineTableByModel(criteria.model);
        console.log("PostgresJSONQueryStrategy.prototype.composeSingle -  model: " + criteria.model);
        console.log("PostgresJSONQueryStrategy.prototype.composeSingle - mapped fields: " + fieldsForSubqueriesMap.get(criteria.model));
        query.select= "SELECT " + fieldsForSubqueriesMap.get(criteria.model) + " FROM " + query.table;
        let tableAlias = previousOutput.lastPosition ? "" : " d";
        let tablePrefix = previousOutput.lastPosition ? "" : "d.";
        query.where = "WHERE " + tablePrefix + "type = $" + (++previousOutput.lastPosition);
        previousOutput.parameters.push(criteria.dataType);
        let fieldQueries = [], value;
        if (criteria.content) {
            for (let i=0; i<criteria.content.length; i++) {
                let res, op, element = criteria.content[i];
                if (element.dataType) {
                    res = this.composeSingle(element, previousOutput, { alias: 'nested_'+(++previousOutput.cteCount)});
                    previousOutput = res.previousOutput;
                    query.subqueries.push(_.omit(res, 'previousOutput'));
                }
                else if (element.personalDetails) {
                    op = this.composeSpecializedPersonalDetailsQuery(element, previousOutput);
                    previousOutput = op.previousOutput;
                    query.subqueries.push(_.omit(op, ['previousOutput', 'subquery']));
                    fieldQueries.push(op.subquery);
                }
                else if (element.specializedQuery) {
                    op = this.composeSpecializedQuery(element, previousOutput, tablePrefix);
                    if (!op) {
                        continue;
                    }
                    fieldQueries.push(op.subquery);
                    previousOutput.lastPosition = op.lastParameterPosition;
                    previousOutput.parameters = op.parameters;
                }
                else {
                    op = this.getSubqueryRow(element, previousOutput, tablePrefix);
                    if (!op) {
                        continue;
                    }
                    fieldQueries.push(op.subquery);
                }
            }
        }
        fieldQueries = _.compact(fieldQueries);
        if (fieldQueries.length) {
            let junction = criteria.junction === 'OR' ? 'OR' : 'AND';
            query.where += " AND (" + fieldQueries.map(function(row) {return "(" + row + ")"; }).join(" " + junction + " ") + ")";
        }
        query.select += tableAlias;
        // query.previousOutput =  _.extend(previousOutput, {parameters: _.flatten(previousOutput.parameters)});
        query.previousOutput = previousOutput;
        return query; // _.extend(previousOutput, {statement: query, parameters: _.flatten(previousOutput.parameters)});
    }

    /**
     * @name composeCommonTableExpression
     * @description given a list of sub-queries, the procedure stores them in a WITH statement (a.k.a Common Table Expression)
     * @return {Object} - ctes: the complete WITH statement
     */
    composeCommonTableExpression(query, ctes, parentAlias, parentTable) {
        if (!ctes) {
            ctes = [];
        }
        else if (query.alias === "pd") {  // PERSONAL_DETAILS table
            // let joinClause = "INNER JOIN " + query.alias + " ON " + query.alias + ".id = " + parentAlias + ".personal_info";
            ctes.push({
                alias: query.alias,
                commonTableExpression: query.alias + " AS (" + _.compact([query.select, query.where]).join(" ") + ")",
                joinClause: "LEFT JOIN " + query.alias + " ON " + query.alias + ".id = " + parentAlias + ".personal_info"
            });
            return ctes;
        }
        else {
            // let model = "data";
            let joinClause = "INNER JOIN " + query.alias + " ON " + query.alias + ".parent_" + parentTable + " = " + parentAlias + ".id";
            ctes.push({
                alias: query.alias,
                commonTableExpression: query.alias + " AS (" + query.select + " " + query.where + ")",
                joinClause: joinClause
            });
        }
        let alias = query.alias || 'd';
        let qLen = query.subqueries && query.subqueries.length;
        for (let i=0; i<qLen; i++) {
            ctes = this.composeCommonTableExpression(query.subqueries[i], ctes, alias, query.table);
        }
        return ctes;
    }

    /**
     * @method
     * @override
     * @name compose
     * @description composes a query based on a single DataType
     * @param{Object} criteria - the query criteria object
     */
    compose(criteria) {
        let query = this.composeSingle(criteria);
        let ctes = [];
        let specificFields = fieldsForMainQueryMap.get(criteria.model);

        // No subject and personal details info are required if querying on subjects
        if (criteria.model !== DataTypeClasses.SUBJECT && criteria.wantsSubject) {
            ctes.push({
                alias: 's',
                commonTableExpression: 's AS (SELECT id, code, sex, personal_info FROM subject)',
                joinClause: 'LEFT JOIN s ON s.id = d.parent_subject'
            });
            specificFields += "s.code, s.sex, ";

            if (criteria.wantsPersonalInfo) {
                ctes.push({
                    alias: 'pd',
                    commonTableExpression: 'pd AS (SELECT id, given_name, surname, birth_date FROM personal_details)',
                    joinClause: 'LEFT JOIN pd ON pd.id = s.personal_info'
                });
                specificFields += "pd.given_name, pd.surname, pd.birth_date, ";
            }
        }

        if (criteria.model === DataTypeClasses.SUBJECT && criteria.wantsPersonalInfo) {
            specificFields += "pd.given_name, pd.surname, pd.birth_date, ";
        }

        if (criteria.model === DataTypeClasses.SAMPLE) {
            ctes.push({
                alias: 'bb',
                commonTableExpression: 'bb AS (SELECT id, biobank_id, acronym, name FROM biobank)',
                joinClause: 'LEFT JOIN bb ON bb.id = d.biobank'
            });
            specificFields += "bb.acronym AS biobank_acronym, ";
        }

        ctes = ctes.concat(this.composeCommonTableExpression(query));
        console.log(ctes);
        let commonTableExpressions = "", joins = " ";
        query.select = "SELECT DISTINCT d.id, " + specificFields + "d.metadata FROM " + query.table + " d";

        if (ctes.length) {
            commonTableExpressions = "WITH " + _.pluck(ctes, 'commonTableExpression').join(", ");
            joins = " " + _.pluck(ctes, 'joinClause').join(" ") + " ";
        }
        let mainStatement = query.select + joins + query.where;
        mainStatement = (commonTableExpressions + " " + mainStatement).trim() + ";";
        return { statement: mainStatement, parameters: query.previousOutput.parameters };
    }

}

/**
 * @class
 * @name WtJSONBQueryStrategy
 * @extends WtJSONQueryStrategy
 */
class WtJSONBQueryStrategy extends WtJSONQueryStrategy {

   /**
     * @method
     * @override
     * @name getSubqueryRow
     * @description compose a (sub)query fragment based a a single criterium (a single paeameter and a condition
     *              over the parameter)
     */
    getSubqueryRow(element, previousOutput, tablePrefix) {

        if(_.isEmpty(element)) {
            return null;
        }

        if (allowedComparators.indexOf(element.comparator) < 0) {
            console.log(element.comparator);
            throw new Error("Operation not allowed. Trying to inject a forbidden comparator!!");
        }

        if (element.isInLoop) {
            console.log("PostgresJSONBQueryStrategy - executing loop composition algorithm - " + element.isInLoop);
            return this.getSubqueryRowLoop(element, previousOutput, tablePrefix);
        }

        return this.getSubqueryRowAttribute(element, previousOutput, tablePrefix);
    }


    /**
     * @method
     * @name getSubqueryRowAttribute
     * @description
     */
    getSubqueryRowAttribute(element, previousOutput, tablePrefix) {

        let boolValue, i, subquery = "", subqueries = [], param = {}, operatorPrefix;

        if (element.fieldType === "boolean") {
            boolValue = _.isBoolean(element.fieldValue) ? element.fieldValue : (element.fieldValue.toLowerCase() === 'true');
            // param = "{\"" + element.fieldName + "\":{\"value\":" + boolValue + "}}";
            // param = {};
            param[element.fieldName] = {value: boolValue};
            subquery = tablePrefix + "metadata @> $" + (++previousOutput.lastPosition);
            previousOutput.parameters.push(JSON.stringify(param));
        }

        else if (element.isList) {
            // if the comparator has a not condition add it a prefix
            operatorPrefix = element.comparator === 'NOT IN' ? 'NOT ' : '';

            subqueries = [];
            for (i=0; i<element.fieldValue.length; i++) {
                param = "{\"" + element.fieldName + "\":{\"value\":\"" + element.fieldValue[i] + "\"}}";
                subqueries.push(operatorPrefix + tablePrefix + "metadata @> $" + (++previousOutput.lastPosition));
                previousOutput.parameters.push(param);
            }
            // join all conditions from a list with or
            subquery = subqueries.join(" OR ");
        }

        // if it is an equality matching use JSONB containment (@>) operator
        else if (element.comparator === '=' || element.comparator === '<>') { // NOTE: "!=" operator is not allowed since it is not standard SQL

            // if the comparator has an inequality condition add a NOT a prefix
            operatorPrefix = element.comparator === '<>' ? 'NOT ' : '';

            let value = element.fieldType === FieldTypes.INTEGER ? _.parseInt(element.fieldValue) :
               element.fieldType === FieldTypes.FLOAT ? Number(element.fieldValue) :
               element.caseInsensitive ? element.fieldValue.toUpperCase() : element.fieldValue;

            // param = {};
            param[element.fieldName] = {value: value};
            subquery = operatorPrefix + tablePrefix + "metadata @> $" + (++previousOutput.lastPosition);
            previousOutput.parameters.push(JSON.stringify(param));
        }

        // otherwise use the standard JSON/JSONB accessor (->/->>) operator
        else {
            subquery = "(" + tablePrefix + "metadata->$" + (++previousOutput.lastPosition) + "->>'value')::" + element.fieldType.toLowerCase()  +
                " " + element.comparator + " $" + (++previousOutput.lastPosition);
            previousOutput.parameters.push(element.fieldName);
            previousOutput.parameters.push(element.fieldValue);
        }

        // add condition on unit if present
        if (element.fieldUnit) {
            param = "{\"" + element.fieldName + "\":{\"unit\":\"" + element.fieldUnit + "\"}}";
            subquery += " AND ";
            subquery +=  tablePrefix + "metadata @> $" + (++previousOutput.lastPosition);
            previousOutput.parameters.push(param);
        }
        // flatten nested arrays (if any)
        console.log(previousOutput.parameters);
        previousOutput.parameters = _.flatten(previousOutput.parameters);
        return {subquery: subquery, previousOutput: previousOutput};

    }

    /**
     * @method
     * @name getSubqueryRowLoop
     */
    getSubqueryRowLoop(element, previousOutput, tablePrefix) {

        let subquery = "", operatorPrefix, jsonbValue = {};

        if (element.comparator === '=' || element.comparator === '<>') {
            operatorPrefix = element.comparator === '<>' ? 'NOT ' : '';
            subquery = operatorPrefix + tablePrefix + "metadata @> $" + (++previousOutput.lastPosition);
            // if case-insensitive turn the value to uppercase
            let val = element.fieldType === FieldTypes.INTEGER ? _.parseInt(element.fieldValue) :
               element.fieldType === FieldTypes.FLOAT ? Number(element.fieldValue) :
               element.caseInsensitive ? element.fieldValue.toUpperCase() : element.fieldValue;
            jsonbValue[element.fieldName] = {values: [val]};
        }

        // ALL VALUES operator
        else if (element.comparator === '?&') {
            operatorPrefix = element.comparator !== '?&' ? 'NOT ' : '';     // TODO so far no negative query implemented for this one
            subquery = operatorPrefix + tablePrefix + "metadata @> $" + (++previousOutput.lastPosition);
            let val = element.fieldType === FieldTypes.INTEGER ? _.map(element.fieldValue, el => _.parseInt(el)) :
                element.fieldType === FieldTypes.FLOAT ? _.map(element.fieldValue, el => Number(el)) :
                element.caseInsensitive ? _.map(element.fieldValue, el => el.toUpperCase()) : element.fieldValue;
            jsonbValue[element.fieldName] = {values: val};
        }

        // ANY OF THE VALUES operator
        else if (element.comparator === '?|') {
            operatorPrefix = ""; // TODO: so far no operator prefix
            subquery = "(" + operatorPrefix + tablePrefix + "metadata->$" + (++previousOutput.lastPosition) + "->'values' " + element.comparator + " $" + (++previousOutput.lastPosition) + ")";
            // if case-insensitive turn all values to uppercase
            jsonbValue = element.caseInsensitive ? _.map(element.fieldValue, el => el.toUpperCase()) : element.fieldValue;
            previousOutput.parameters.push(element.fieldName);
        }

        // string pattern matching queries (both case sensitive and insensitive)
        else if (['LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE'].indexOf(element.comparator) > -1) {
            subquery = "EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.metadata->$" + (++previousOutput.lastPosition) +
                "->'values') WHERE value " + element.comparator + " $" + (++previousOutput.lastPosition) + ")";
            previousOutput.parameters.push(element.fieldName, element.fieldValue);
        }

        // add the jsonb value only if it not empty
        if (!_.isEmpty(jsonbValue)) {
            previousOutput.parameters.push(_.isArray(jsonbValue) ? jsonbValue : JSON.stringify(jsonbValue));
        }

        return {subquery: subquery, previousOutput: previousOutput};

    }

}

module.exports.WtQueryStrategy = WtQueryStrategy;
module.exports.WtJSONQueryStrategy = WtJSONQueryStrategy;
module.exports.WtJSONBQueryStrategy = WtJSONBQueryStrategy;
