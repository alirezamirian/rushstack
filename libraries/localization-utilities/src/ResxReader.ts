// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { FileSystem, ITerminal, Text, NewlineKind } from '@rushstack/node-core-library';
import { XmlDocument, XmlElement } from 'xmldoc';

import { ILocalizedString, ILocalizationFile } from './interfaces';

const STRING_NAME_RESX: RegExp = /^[A-z_$][A-z0-9_$]*$/;

/**
 * @public
 */
export interface IResxReaderOptions {
  resxFilePath: string;
  terminal: ITerminal;
  newlineNormalization: NewlineKind | undefined;
  warnOnMissingComment: boolean;
}

interface ILoggingFunctions {
  logError: (message: string) => void;
  logWarning: (message: string) => void;
  logFileError: (message: string, filePath: string, line?: number, position?: number) => void;
  logFileWarning: (message: string, filePath: string, line?: number, position?: number) => void;
}

interface IResxReaderOptionsInternal extends Omit<IResxReaderOptions, 'terminal'> {
  resxContents: string;
  loggingFunctions: ILoggingFunctions;
}

/**
 * @public
 */
export function readResxFileAsLocFile(options: IResxReaderOptions): ILocalizationFile {
  const resxContents: string = FileSystem.readFile(options.resxFilePath);
  return readResxAsLocFile(resxContents, options);
}

/**
 * @public
 */
export function readResxAsLocFile(resxContents: string, options: IResxReaderOptions): ILocalizationFile {
  const writeError: (message: string) => void = options.terminal.writeErrorLine.bind(options.terminal);
  const writeWarning: (message: string) => void = options.terminal.writeWarningLine.bind(options.terminal);
  const loggingFunctions: ILoggingFunctions = {
    logError: (message: string) => writeError(message),
    logWarning: (message: string) => writeWarning(message),
    logFileError: (message: string, filePath: string, line?: number, position?: number) => {
      _logWithLocation(writeError, message, filePath, line, position);
    },
    logFileWarning: (message: string, filePath: string, line?: number, position?: number) => {
      _logWithLocation(writeWarning, message, filePath, line, position);
    }
  };

  return _readResxAsLocFileInternal({
    ...options,
    resxContents,
    loggingFunctions
  });
}

function _readResxAsLocFileInternal(options: IResxReaderOptionsInternal): ILocalizationFile {
  const xmlDocument: XmlDocument = new XmlDocument(options.resxContents);

  if (xmlDocument.name !== 'root') {
    _logErrorWithLocation(
      options,
      `Expected RESX to have a "root" element, found "${xmlDocument.name}"`,
      xmlDocument
    );
  }

  const locFile: ILocalizationFile = {};

  for (const childNode of xmlDocument.children) {
    switch (childNode.type) {
      case 'element': {
        switch (childNode.name) {
          case 'data': {
            const stringName: string = childNode.attr.name;
            if (!stringName) {
              _logErrorWithLocation(options, 'Unexpected missing or empty string name', childNode);
            } else if (!STRING_NAME_RESX.test(stringName)) {
              _logErrorWithLocation(options, `Invalid string name "${stringName}"`, childNode);
            } else {
              if (locFile.hasOwnProperty(stringName)) {
                _logErrorWithLocation(options, `Duplicate string value "${stringName}"`, childNode);
              }

              const locString: ILocalizedString | undefined = _readDataElement(options, childNode);

              if (locString) {
                locFile[stringName] = locString;
              }
            }

            break;
          }

          // Other allowed elements
          case 'xsd:schema':
          case 'resheader':
            break;

          default:
            _logErrorWithLocation(options, `Unexpected RESX element ${childNode.name}`, childNode);
        }

        break;
      }

      case 'text': {
        if (childNode.text.trim() !== '') {
          _logErrorWithLocation(options, 'Found unexpected non-empty text node in RESX');
        }

        break;
      }

      case 'comment':
        break;

      default:
        _logErrorWithLocation(options, `Unexpected ${childNode.type} child in RESX`);
        break;
    }
  }

  return locFile;
}

function _readDataElement(
  options: IResxReaderOptionsInternal,
  dataElement: XmlElement
): ILocalizedString | undefined {
  let foundCommentElement: boolean = false;
  let foundValueElement: boolean = false;
  let comment: string | undefined = undefined;
  let value: string | undefined = undefined;

  for (const childNode of dataElement.children) {
    switch (childNode.type) {
      case 'element': {
        switch (childNode.name) {
          case 'value': {
            if (foundValueElement) {
              _logErrorWithLocation(options, 'Duplicate <value> element found', childNode);
            } else {
              foundValueElement = true;
              value = _readTextElement(options, childNode);
              if (value && options.newlineNormalization) {
                value = Text.convertTo(value, options.newlineNormalization);
              }
            }

            break;
          }

          case 'comment': {
            if (foundCommentElement) {
              _logErrorWithLocation(options, 'Duplicate <comment> element found', childNode);
            } else {
              foundCommentElement = true;
              comment = _readTextElement(options, childNode);
            }

            break;
          }

          default:
            _logErrorWithLocation(options, `Unexpected RESX element ${childNode.name}`, childNode);
            break;
        }

        break;
      }

      case 'text': {
        if (childNode.text.trim() !== '') {
          _logErrorWithLocation(
            options,
            'Found unexpected non-empty text node in RESX <data> element',
            dataElement
          );
        }

        break;
      }

      case 'comment':
        break;

      default:
        _logErrorWithLocation(
          options,
          `Unexpected ${childNode.type} child in RESX <data> element`,
          dataElement
        );
    }
  }

  if (!foundValueElement) {
    _logErrorWithLocation(options, 'Missing string value in <data> element', dataElement);
  } else {
    if (comment === undefined && options.warnOnMissingComment) {
      _logWarningWithLocation(options, 'Missing string comment in <data> element', dataElement);
    }

    return {
      value: value || '',
      comment
    };
  }
}

function _readTextElement(options: IResxReaderOptionsInternal, element: XmlElement): string | undefined {
  let foundText: string | undefined = undefined;

  for (const childNode of element.children) {
    switch (childNode.type) {
      case 'cdata':
      case 'text': {
        if (foundText !== undefined) {
          _logErrorWithLocation(options, 'More than one child node found containing text content', element);
          break;
        }

        foundText = childNode.type === 'text' ? childNode.text : childNode.cdata;
        break;
      }

      case 'comment':
        break;

      case 'element':
        _logErrorWithLocation(options, `Unexpected element`, childNode);
        break;

      default:
        _logErrorWithLocation(options, `Unexpected ${element.type} child`, element);
        break;
    }
  }

  return foundText;
}

function _logErrorWithLocation(
  options: IResxReaderOptionsInternal,
  message: string,
  element?: XmlElement | XmlDocument
): void {
  if (element) {
    options.loggingFunctions.logFileError(
      message,
      options.resxFilePath,
      element.line + 1,
      element.column + 1
    );
  } else {
    options.loggingFunctions.logFileError(message, options.resxFilePath);
  }
}

function _logWarningWithLocation(
  options: IResxReaderOptionsInternal,
  message: string,
  element?: XmlElement | XmlDocument
): void {
  if (element) {
    options.loggingFunctions.logFileWarning(
      message,
      options.resxFilePath,
      element.line + 1,
      element.column + 1
    );
  } else {
    options.loggingFunctions.logFileWarning(message, options.resxFilePath);
  }
}

function _logWithLocation(
  loggingFn: (message: string) => void,
  message: string,
  filePath: string,
  line?: number,
  position?: number
): void {
  let location: string;
  if (position !== undefined) {
    location = `${filePath}(${line},${position})`;
  } else if (line !== undefined) {
    location = `${filePath}(${line})`;
  } else {
    location = filePath;
  }

  loggingFn(`${location}: ${message}`);
}
