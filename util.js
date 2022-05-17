'use strict';

/**
 * @typedef {import('eslint').ESLint}                 ESLint
 * @typedef {import('eslint').ESLint.LintResult}      ESLint.LintResult
 * @typedef {import('eslint').ESLint.LintResultData}  ESLint.LintResultData
 * @typedef {import('.').GulpESLintWriter}            GulpESLintWriter
 * @typedef {import('eslint').Linter}                 Linter
 * @typedef {import('eslint').Linter.LintMessage}     Linter.LintMessage
 * @typedef
 * {{ format(results: ESLint.LintResult[]): string | Promise<string>; }}
 * LoadedFormatter
 */

/**
 * @callback FormatterFunction
 * @param {ESLint.LintResult[]} results
 * @param {ESLint.LintResultData} [data]
 * @returns {string | Promise<string>}
 */

const fancyLog      = require('fancy-log');
const { relative }  = require('path');
const PluginError   = require('plugin-error');
const { Transform } = require('stream');
const ternaryStream = require('ternary-stream');

const ESLintKey = Symbol('ESLint');

function compareResultsByFilePath({ filePath: filePath1 }, { filePath: filePath2 }) {
    if (filePath1 > filePath2) {
        return 1;
    }
    if (filePath1 < filePath2) {
        return -1;
    }
    return 0;
}

function createPluginError(error) {
    if (error instanceof PluginError) {
        return error;
    }
    if (error == null) {
        error = 'Unknown Error';
    }
    return new PluginError('gulp-eslint-new', error, { showStack: true });
}

const { defineProperty } = Object;

/** Determine if the specified object has the indicated property as its own property. */
const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);

/**
 * Determine if a message is an error.
 *
 * @param {Linter.LintMessage} { severity } - An ESLint message.
 * @returns {boolean} Whether the message is an error message.
 */
function isErrorMessage({ severity }) {
    return severity > 1;
}

const isObject = value => Object(value) === value;

/**
 * Determine if a message is a warning.
 *
 * @param {Linter.LintMessage} { severity } - An ESLint message.
 * @returns {boolean} Whether the message is a warning message.
 */
function isWarningMessage({ severity }) {
    return severity === 1;
}

/**
 * Resolve a formatter from a string.
 * If a function is specified, it will be treated as a formatter function and wrapped in an object
 * appropriately.
 *
 * @param {{ cwd: string, eslint: ESLint }} eslintInfo
 * Current directory and instance of ESLint used to load and configure the formatter.
 *
 * @param {string|LoadedFormatter|FormatterFunction} [formatter]
 * A name or path of a formatter, a formatter object or a formatter function.
 *
 * @returns {Promise<LoadedFormatter>} An ESLint formatter.
 */
function resolveFormatter({ cwd, eslint }, formatter) {
    if (isObject(formatter) && typeof formatter.format === 'function') {
        return formatter;
    }
    if (typeof formatter === 'function') {
        return {
            format: results => {
                results.sort(compareResultsByFilePath);
                return formatter(
                    results,
                    {
                        cwd,
                        get rulesMeta() {
                            const rulesMeta = eslint.getRulesMetaForResults(results);
                            defineProperty(this, 'rulesMeta', { value: rulesMeta });
                            return rulesMeta;
                        }
                    }
                );
            }
        };
    }
    // Use ESLint to look up formatter references.
    return eslint.loadFormatter(formatter);
}

exports.ESLintKey = ESLintKey;

exports.compareResultsByFilePath = compareResultsByFilePath;

const isHiddenRegExp = /(?<![^/\\])\.(?!\.)/u;
const isInNodeModulesRegExp = /(?<![^/\\])node_modules[/\\]/u;

/**
 * This is a remake of the CLI engine `createIgnoreResult` function with no reference to ESLint CLI
 * options and with a better detection of the ignore reason in some edge cases.
 *
 * @param {string} filePath - Absolute path of checked code file.
 * @param {string} baseDir - Absolute path of base directory.
 * @returns {ESLint.LintResult} Result with warning by ignore settings.
 */
exports.createIgnoreResult = (filePath, baseDir) => {
    let message;
    const relativePath = relative(baseDir, filePath);
    if (isHiddenRegExp.test(relativePath)) {
        message
        = 'File ignored by default. Use a negated ignore pattern (like '
        + '"!<relative/path/to/filename>") to override.';
    } else if (isInNodeModulesRegExp.test(relativePath)) {
        message
        = 'File ignored by default. Use a negated ignore pattern like "!node_modules/*" to '
        + 'override.';
    } else {
        message
        = 'File ignored because of a matching ignore pattern. Set "ignore" option to false to '
        + 'override.';
    }
    return {
        filePath,
        messages: [{ fatal: false, severity: 1, message }],
        errorCount: 0,
        warningCount: 1,
        fixableErrorCount: 0,
        fixableWarningCount: 0,
        fatalErrorCount: 0
    };
};

exports.createPluginError = createPluginError;

async function awaitHandler(handler, data, done) {
    try {
        await handler();
    } catch (err) {
        done(createPluginError(err));
        return;
    }
    done(null, data);
}

/**
 * Create a transform stream in object mode from synchronous or asynchronous handler functions.
 * All files are passed through the stream.
 * Errors thrown by the handlers will be wrapped in a `PluginError` and emitted from the stream.
 *
 * @param {Function} handleFile
 * A function that is called for each file, with the file object as the only parameter.
 * If the function returns a promise, the file will be passed through the stream after the promise
 * is resolved.
 *
 * @param {Function} [handleFinal]
 * A function that is called with no parameters before closing the stream.
 * If the function returns a promise, the stream will be closed after the promise is resolved.
 *
 * @returns {Transform} A transform stream.
 */
exports.createTransform = (handleFile, handleFinal) => {
    const transform = (file, enc, done) => void awaitHandler(() => handleFile(file), file, done);
    const final = handleFinal ? done => void awaitHandler(handleFinal, null, done) : undefined;
    return new Transform({ objectMode: true, transform, final });
};

/**
 * Increment count if message is an error.
 *
 * @param {number} count - Number of errors.
 * @param {Linter.LintMessage} message - An ESLint message.
 * @returns {number} The number of errors, message included.
 */
function countErrorMessage(count, message) {
    return count + Number(isErrorMessage(message));
}

/**
 * Increment count if message is a warning.
 *
 * @param {number} count - Number of warnings.
 * @param {Linter.LintMessage} message - An ESLint message.
 * @returns {number} The number of warnings, message included.
 */
function countWarningMessage(count, message) {
    return count + Number(isWarningMessage(message));
}

/**
 * Increment count if message is a fixable error.
 *
 * @param {number} count - Number of fixable errors.
 * @param {Linter.LintMessage} message - An ESLint message.
 * @returns {number} The number of fixable errors, message included.
 */
function countFixableErrorMessage(count, message) {
    return count + Number(isErrorMessage(message) && message.fix !== undefined);
}

/**
 * Increment count if message is a fixable warning.
 *
 * @param {Number} count - Number of fixable warnings.
 * @param {Linter.LintMessage} message - An ESLint message.
 * @returns {Number} The number of fixable warnings, message included.
 */
function countFixableWarningMessage(count, message) {
    return count + Number(isWarningMessage(message) && message.fix !== undefined);
}

/**
 * Increment count if message is a fatal error.
 *
 * @param {Number} count - Number of fatal errors.
 * @param {Linter.LintMessage} message - An ESLint message.
 * @returns {Number} The number of fatal errors, message included.
 */
function countFatalErrorMessage(count, message) {
    return count + Number(isErrorMessage(message) && !!message.fatal);
}

/**
 * Filter result messages, update error and warning counts.
 *
 * @param {ESLint.LintResult} result - An ESLint result.
 * @param {Function} filter - A function that evaluates what messages to keep.
 * @returns {ESLint.LintResult} A filtered ESLint result.
 */
exports.filterResult = (result, filter) => {
    const { messages, ...newResult } = result;
    const newMessages = messages.filter(filter, result);
    newResult.messages = newMessages;
    newResult.errorCount          = newMessages.reduce(countErrorMessage, 0);
    newResult.warningCount        = newMessages.reduce(countWarningMessage, 0);
    newResult.fixableErrorCount   = newMessages.reduce(countFixableErrorMessage, 0);
    newResult.fixableWarningCount = newMessages.reduce(countFixableWarningMessage, 0);
    newResult.fatalErrorCount     = newMessages.reduce(countFatalErrorMessage, 0);
    return newResult;
};

const isFixed = ({ eslint }) => eslint && eslint.fixed;
const getBase = ({ base }) => base;
exports.fix = dest => ternaryStream(isFixed, dest(getBase));

exports.hasOwn = hasOwn;

exports.isErrorMessage = isErrorMessage;

exports.isWarningMessage = isWarningMessage;

const forbiddenOptions = [
    'cache',
    'cacheFile',
    'cacheLocation',
    'cacheStrategy',
    'errorOnUnmatchedPattern',
    'extensions',
    'globInputPaths'
];

/**
 * Throws an error about invalid options passed to gulp-eslint-new.
 *
 * @param {string} message - The error message.
 * @throws An error with code "ESLINT_INVALID_OPTIONS" and the specified message.
 */
function throwInvalidOptionError(message) {
    const error = Error(message);
    Error.captureStackTrace(error, throwInvalidOptionError);
    error.code = 'ESLINT_INVALID_OPTIONS';
    throw error;
}

/**
 * Convert a string array to a boolean map.
 *
 * @param {string[]|null} keys - The keys to assign true.
 * @param {boolean} defaultValue - The default value for each property.
 * @param {string} displayName - The property name which is used in error message.
 * @returns {Record<string,boolean>} The boolean map.
 */
function toBooleanMap(keys, defaultValue, displayName) {
    if (keys && !Array.isArray(keys)) {
        throwInvalidOptionError(`Option ${displayName} must be an array`);
    }
    if (keys && keys.length > 0) {
        return keys.reduce(
            (map, def) => {
                const [key, value] = def.split(':');
                if (key !== '__proto__') {
                    map[key] = value === undefined ? defaultValue : value === 'true';
                }
                return map;
            },
            { }
        );
    }
}

/**
 * Create config helper to merge various config sources.
 *
 * @param {Object} [options] - Options to migrate.
 * @returns {Object} Migrated options.
 */
exports.migrateOptions = (options = { }) => {
    if (typeof options === 'string') {
        // Basic config path overload: `eslint('path/to/config.json')`.
        const returnValue = { eslintOptions: { overrideConfigFile: options } };
        return returnValue;
    }
    const {
        [ESLintKey]: rawESLint,
        overrideConfig: rawOverrideConfig,
        quiet,
        warnFileIgnored,
        warnIgnored: rawWarnIgnored,
        ...eslintOptions
    }
    = options;
    {
        const invalidOptions = forbiddenOptions.filter(option => hasOwn(options, option));
        if (invalidOptions.length) {
            throwInvalidOptionError(`Invalid options: ${invalidOptions.join(', ')}`);
        }
    }
    if (rawOverrideConfig != null && typeof rawOverrideConfig !== 'object') {
        throwInvalidOptionError('Option overrideConfig must be an object or null');
    }
    const overrideConfig = eslintOptions.overrideConfig
    = rawOverrideConfig != null ? { ...rawOverrideConfig } : { };

    function migrateOption(oldName, newName = oldName, convert = value => value) {
        const value = eslintOptions[oldName];
        delete eslintOptions[oldName];
        if (value !== undefined) {
            overrideConfig[newName] = convert(value);
        }
    }

    {
        const { configFile } = eslintOptions;
        delete eslintOptions.configFile;
        if (configFile !== undefined) {
            eslintOptions.overrideConfigFile = configFile;
        }
    }
    migrateOption('envs', 'env', envs => toBooleanMap(envs, true, 'envs'));
    migrateOption('extends');
    migrateOption('globals', undefined, globals => toBooleanMap(globals, false, 'globals'));
    migrateOption('ignorePattern', 'ignorePatterns');
    migrateOption('parser');
    migrateOption('parserOptions');
    if (Array.isArray(eslintOptions.plugins)) {
        migrateOption('plugins');
    }
    migrateOption('rules');
    const ESLint = rawESLint || require('eslint').ESLint;
    const warnIgnored = warnFileIgnored !== undefined ? warnFileIgnored : rawWarnIgnored;
    const returnValue = { ESLint, eslintOptions, quiet, warnIgnored };
    return returnValue;
};

exports.resolveFormatter = resolveFormatter;

/**
 * Resolve a writer function used to write formatted ESLint messages.
 *
 * @param {GulpESLintWriter|NodeJS.WritableStream} [writer=fancyLog]
 * A stream or function to resolve as a format writer.
 * @returns {GulpESLintWriter} A function that writes formatted messages.
 */
exports.resolveWriter = (writer = fancyLog) => {
    if (isObject(writer)) {
        const { write } = writer;
        if (typeof write === 'function') {
            writer = write.bind(writer);
        }
    }
    return writer;
};

/**
 * Write formatted ESLint messages.
 *
 * @param {ESLint.LintResult[]} results
 * A list of ESLint results.
 *
 * @param {LoadedFormatter} formatterObj
 * A formatter object.
 *
 * @param {GulpESLintWriter} [writer]
 * A function used to write formatted ESLint messages.
 */
exports.writeResults = async (results, formatterObj, writer) => {
    const message = await formatterObj.format(results);
    if (writer && message != null && message !== '') {
        await writer(message);
    }
};
