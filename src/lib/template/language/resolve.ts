import { hexToBin, utf8ToBin } from '../../format/format';
import { bigIntToScriptNumber } from '../../vm/instruction-sets/instruction-sets';
import {
  AnyCompilationEnvironment,
  CompilationData,
  CompilationEnvironment,
  CompilerOperation,
} from '../compiler-types';
import { AuthenticationTemplateVariable } from '../template-types';

import { CompilationResultSuccess, compileScript } from './compile';
import { BtlScriptSegment, MarkedNode } from './parse';

export interface Range {
  endColumn: number;
  endLineNumber: number;
  startColumn: number;
  startLineNumber: number;
}

const pluckRange = (node: MarkedNode): Range => ({
  endColumn: node.end.column,
  endLineNumber: node.end.line,
  startColumn: node.start.column,
  startLineNumber: node.start.line,
});

interface ResolvedSegmentBase {
  range: Range;
  type: string;
}

export interface ResolvedSegmentPush<T> extends ResolvedSegmentBase {
  type: 'push';
  value: T;
}

export interface ResolvedSegmentEvaluation<T> extends ResolvedSegmentBase {
  type: 'evaluation';
  value: T;
}

export interface ResolvedSegmentVariableBytecode extends ResolvedSegmentBase {
  type: 'bytecode';
  value: Uint8Array;
  variable: string;
}

export interface ResolvedSegmentScriptBytecode extends ResolvedSegmentBase {
  script: string;
  source: ResolvedScript;
  type: 'bytecode';
  value: Uint8Array;
}

export interface ResolvedSegmentOpcodeBytecode extends ResolvedSegmentBase {
  opcode: string;
  type: 'bytecode';
  value: Uint8Array;
}

export interface ResolvedSegmentLiteralBytecode extends ResolvedSegmentBase {
  literalType: 'BigIntLiteral' | 'HexLiteral' | 'UTF8Literal';
  type: 'bytecode';
  value: Uint8Array;
}

export type ResolvedSegmentBytecode =
  | ResolvedSegmentLiteralBytecode
  | ResolvedSegmentOpcodeBytecode
  | ResolvedSegmentScriptBytecode
  | ResolvedSegmentVariableBytecode;

export interface ResolvedSegmentComment extends ResolvedSegmentBase {
  type: 'comment';
  value: string;
}

export interface ResolvedSegmentError extends ResolvedSegmentBase {
  type: 'error';
  value: string;
}

export type ResolvedSegment =
  | ResolvedSegmentPush<ResolvedScript>
  | ResolvedSegmentEvaluation<ResolvedScript>
  | ResolvedSegmentBytecode
  | ResolvedSegmentComment
  | ResolvedSegmentError;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ResolvedScript extends Array<ResolvedSegment> {}

export enum IdentifierResolutionType {
  opcode = 'opcode',
  variable = 'variable',
  script = 'script',
}

export enum IdentifierResolutionErrorType {
  unknown = 'unknown',
  variable = 'variable',
  script = 'script',
}

/**
 * A method which accepts a string and returns either the successfully resolved
 * bytecode or an error. The string will never be empty (`''`), so resolution
 * can skip checking the string's length.
 */
export type IdentifierResolutionFunction = (
  identifier: string
) =>
  | {
      bytecode: Uint8Array;
      status: true;
      type: IdentifierResolutionType.opcode | IdentifierResolutionType.variable;
    }
  | {
      bytecode: Uint8Array;
      source: ResolvedScript;
      status: true;
      type: IdentifierResolutionType.script;
    }
  | {
      error: string;
      type:
        | IdentifierResolutionErrorType.variable
        | IdentifierResolutionErrorType.unknown;
      status: false;
    }
  | {
      error: string;
      type: IdentifierResolutionErrorType.script;
      scriptId: string;
      status: false;
    };

export const resolveScriptSegment = (
  segment: BtlScriptSegment,
  resolveIdentifiers: IdentifierResolutionFunction
): ResolvedScript => {
  // eslint-disable-next-line complexity
  const resolved = segment.value.map<ResolvedSegment>((child) => {
    const range = pluckRange(child);
    switch (child.name) {
      case 'Identifier': {
        const identifier = child.value;
        const result = resolveIdentifiers(identifier);
        const ret = result.status
          ? {
              range,
              type: 'bytecode' as const,
              value: result.bytecode,
              ...(result.type === IdentifierResolutionType.opcode
                ? {
                    opcode: identifier,
                  }
                : result.type === IdentifierResolutionType.variable
                ? {
                    variable: identifier,
                  }
                : // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                result.type === IdentifierResolutionType.script
                ? { script: identifier, source: result.source }
                : ({ unknown: identifier } as never)),
            }
          : {
              range,
              type: 'error' as const,
              value: result.error,
            };
        return ret;
      }
      case 'Push':
        return {
          range,
          type: 'push' as const,
          value: resolveScriptSegment(child.value, resolveIdentifiers),
        };
      case 'Evaluation':
        return {
          range,
          type: 'evaluation' as const,
          value: resolveScriptSegment(child.value, resolveIdentifiers),
        };
      case 'BigIntLiteral':
        return {
          literalType: 'BigIntLiteral' as const,
          range,
          type: 'bytecode' as const,
          value: bigIntToScriptNumber(child.value),
        };
      case 'HexLiteral':
        return {
          literalType: 'HexLiteral' as const,
          range,
          type: 'bytecode' as const,
          value: hexToBin(child.value),
        };
      case 'UTF8Literal':
        return {
          literalType: 'UTF8Literal' as const,
          range,
          type: 'bytecode' as const,
          value: utf8ToBin(child.value),
        };
      case 'Comment':
        return {
          range,
          type: 'comment' as const,
          value: child.value,
        };
      default:
        return {
          range,
          type: 'error' as const,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          value: `Unrecognized segment: ${(child as any).name as string}`,
        };
    }
  });

  return resolved.length === 0
    ? [{ range: pluckRange(segment), type: 'comment' as const, value: '' }]
    : resolved;
};

export enum BuiltInVariables {
  currentBlockTime = 'current_block_time',
  currentBlockHeight = 'current_block_height',
  signingSerialization = 'signing_serialization',
}

const attemptCompilerOperation = <
  CompilerOperationData,
  Environment extends AnyCompilationEnvironment<CompilerOperationData>
>({
  data,
  environment,
  identifier,
  matchingOperations,
  operationExample = 'operation_identifier',
  operationId,
  variableId,
  variableType,
}: {
  data: CompilationData<CompilerOperationData>;
  environment: Environment;
  identifier: string;
  matchingOperations:
    | {
        [x: string]: CompilerOperation<CompilerOperationData> | undefined;
      }
    | CompilerOperation<CompilerOperationData>
    | undefined;
  operationId: string | undefined;
  variableId: string;
  variableType: string;
  operationExample?: string;
}) => {
  if (matchingOperations === undefined) {
    return `The "${variableId}" variable type can not be resolved because the "${variableType}" operation has not been included in this compiler's CompilationEnvironment.`;
  }
  if (typeof matchingOperations === 'function') {
    const operation = matchingOperations;
    return operation(identifier, data, environment);
  }
  if (operationId === undefined) {
    return `This "${variableId}" variable could not be resolved because this compiler's "${variableType}" operations require an operation identifier, e.g. '${variableId}.${operationExample}'.`;
  }
  const operation = (matchingOperations as {
    [x: string]: CompilerOperation<CompilerOperationData> | undefined;
  })[operationId];
  if (operation === undefined) {
    return `The identifier "${identifier}" could not be resolved because the "${variableId}.${operationId}" operation is not available to this compiler.`;
  }
  return operation(identifier, data, environment);
};

/**
 * If the identifer can be successfully resolved as a variable, the result is
 * returned as a Uint8Array. If the identifier references a known variable, but
 * an error occurs in resolving it, the error is returned as a string.
 * Otherwise, the identifier is not recognized as a variable, and this method
 * simply returns `false`.
 *
 * @param identifier - The full identifier used to describe this operation, e.g.
 * `owner.signature.all_outputs`.
 * @param data - The `CompilationData` provided to the compiler
 * @param environment - The `CompilationEnvironment` provided to the compiler
 */
export const resolveVariableIdentifier = <
  CompilerOperationData,
  Environment extends AnyCompilationEnvironment<CompilerOperationData>
>({
  data,
  environment,
  identifier,
}: {
  data: CompilationData<CompilerOperationData>;
  environment: Environment;
  identifier: string;
}): Uint8Array | string | false => {
  const [variableId, operationId] = identifier.split('.') as [
    string,
    string | undefined
  ];

  switch (variableId) {
    case BuiltInVariables.currentBlockHeight:
      return attemptCompilerOperation({
        data,
        environment,
        identifier,
        matchingOperations: environment.operations?.currentBlockHeight,
        operationId,
        variableId,
        variableType: 'currentBlockHeight',
      });
    case BuiltInVariables.currentBlockTime:
      return attemptCompilerOperation({
        data,
        environment,
        identifier,
        matchingOperations: environment.operations?.currentBlockTime,
        operationId,
        variableId,
        variableType: 'currentBlockTime',
      });
    case BuiltInVariables.signingSerialization:
      return attemptCompilerOperation({
        data,
        environment,
        identifier,
        matchingOperations: environment.operations?.signingSerialization,
        operationExample: 'version',
        operationId,
        variableId,
        variableType: 'signingSerialization',
      });
    default: {
      const expectedVariable: AuthenticationTemplateVariable | undefined =
        environment.variables?.[variableId];

      if (expectedVariable === undefined) {
        return false;
      }
      return attemptCompilerOperation({
        data,
        environment,
        identifier,
        operationId,
        variableId,
        ...{
          AddressData: {
            matchingOperations: environment.operations?.addressData,
            variableType: 'addressData',
          },
          HdKey: {
            matchingOperations: environment.operations?.hdKey,
            operationExample: 'public_key',
            variableType: 'hdKey',
          },
          Key: {
            matchingOperations: environment.operations?.key,
            operationExample: 'public_key',
            variableType: 'key',
          },
          WalletData: {
            matchingOperations: environment.operations?.walletData,
            variableType: 'walletData',
          },
        }[expectedVariable.type],
      });
    }
  }
};

/**
 * Compile an internal script identifier.
 *
 * @remarks
 * If the identifer can be successfully resolved as a script, the script is
 * compiled and returned as a CompilationResultSuccess. If an error occurs in
 * compiling it, the error is returned as a string.
 *
 * Otherwise, the identifier is not recognized as a script, and this method
 * simply returns `false`.
 *
 * @param identifier - the identifier of the script to be resolved
 * @param data - the provided CompilationData
 * @param environment - the provided CompilationEnvironment
 * @param parentIdentifier - the identifier of the script which references the
 * script being resolved (for detecting circular dependencies)
 */
// eslint-disable-next-line complexity
export const resolveScriptIdentifier = <CompilerOperationData, ProgramState>({
  data,
  environment,
  identifier,
  parentIdentifier,
}: {
  identifier: string;
  data: CompilationData<CompilerOperationData>;
  environment: CompilationEnvironment<CompilerOperationData>;
  parentIdentifier?: string;
}): CompilationResultSuccess<ProgramState> | string | false => {
  if ((environment.scripts[identifier] as string | undefined) === undefined) {
    return false;
  }
  if (
    parentIdentifier !== undefined &&
    environment.sourceScriptIds !== undefined &&
    environment.sourceScriptIds.includes(parentIdentifier)
  ) {
    return `A circular dependency was encountered. Script "${identifier}" relies on itself to be generated. (Parent scripts: ${environment.sourceScriptIds.join(
      ', '
    )})`;
  }
  const result = compileScript(identifier, data, {
    ...environment,
    sourceScriptIds: [
      ...(environment.sourceScriptIds === undefined
        ? []
        : environment.sourceScriptIds),
      ...(parentIdentifier === undefined ? [] : [parentIdentifier]),
    ],
  });
  return result.success
    ? result
    : `Compilation error in resolved script, "${identifier}": ${result.errors
        .map(
          ({ error, range }) =>
            // tslint:disable-next-line: no-unsafe-any
            `${error} [${range.startLineNumber}, ${range.startColumn}]`
        )
        .join(', ')}`;
};

/**
 * Return an `IdentifierResolutionFunction` for use in `resolveScriptSegment`.
 *
 * @param scriptId - the `id` of the script for which the resulting
 * `IdentifierResolutionFunction` will be used.
 * @param environment - a snapshot of the context around `scriptId`. See
 * `CompilationEnvironment` for details.
 * @param data - the actual variable values (private keys, shared wallet data,
 * shared address data, etc.) to use in resolving variables.
 */
export const createIdentifierResolver = <CompilerOperationData>({
  data,
  environment,
  scriptId,
}: {
  scriptId: string | undefined;
  data: CompilationData<CompilerOperationData>;
  environment: CompilationEnvironment<CompilerOperationData>;
}): IdentifierResolutionFunction =>
  // eslint-disable-next-line complexity
  (identifier: string) => {
    const opcodeResult: Uint8Array | undefined =
      environment.opcodes?.[identifier];
    if (opcodeResult !== undefined) {
      return {
        bytecode: opcodeResult,
        status: true,
        type: IdentifierResolutionType.opcode,
      };
    }
    const variableResult = resolveVariableIdentifier({
      data,
      environment,
      identifier,
    });
    if (variableResult !== false) {
      return typeof variableResult === 'string'
        ? {
            error: variableResult,
            status: false,
            type: IdentifierResolutionErrorType.variable,
          }
        : {
            bytecode: variableResult,
            status: true,
            type: IdentifierResolutionType.variable,
          };
    }
    const scriptResult = resolveScriptIdentifier({
      data,
      environment,
      identifier,
      parentIdentifier: scriptId,
    });
    if (scriptResult !== false) {
      return typeof scriptResult === 'string'
        ? {
            error: scriptResult,
            scriptId: identifier,
            status: false,
            type: IdentifierResolutionErrorType.script,
          }
        : {
            bytecode: scriptResult.bytecode,
            source: scriptResult.resolve,
            status: true,
            type: IdentifierResolutionType.script,
          };
    }
    return {
      error: `Unknown identifier '${identifier}'.`,
      status: false,
      type: IdentifierResolutionErrorType.unknown,
    };
  };
