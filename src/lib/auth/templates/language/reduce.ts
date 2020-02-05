import { flattenBinArray } from '../../../utils/utils';
import {
  AuthenticationInstruction,
  authenticationInstructionsAreNotMalformed,
  AuthenticationVirtualMachine,
  disassembleBytecode,
  encodeDataPush,
  MinimumProgramState,
  parseBytecode,
  StackState
} from '../../auth';
import { OpcodesCommon } from '../../instruction-sets/common/opcodes';

import { ErrorInformation } from './errors';
import { Range, ResolvedScript } from './resolve';

const pluckStartPosition = (range: Range) => ({
  startColumn: range.startColumn,
  startLineNumber: range.startLineNumber
});

const pluckEndPosition = (range: Range) => ({
  endColumn: range.endColumn,
  endLineNumber: range.endLineNumber
});

const mergeRanges = (ranges: Range[]) => {
  const unsortedMerged = ranges.reduce<Range>(
    // tslint:disable-next-line: cyclomatic-complexity
    (merged, range) => ({
      ...(range.startLineNumber < merged.startLineNumber
        ? pluckStartPosition(range)
        : range.startLineNumber === merged.startLineNumber &&
          range.startColumn < merged.startColumn
        ? pluckStartPosition(range)
        : pluckStartPosition(merged)),
      ...(range.endLineNumber > merged.endLineNumber
        ? pluckEndPosition(range)
        : range.endLineNumber === merged.endLineNumber &&
          range.endColumn > merged.endColumn
        ? pluckEndPosition(range)
        : pluckEndPosition(merged))
    }),
    ranges[0]
  );
  return {
    ...pluckStartPosition(unsortedMerged),
    ...pluckEndPosition(unsortedMerged)
  };
};

export interface ScriptReductionTraceNode {
  bytecode: Uint8Array;
  errors?: ErrorInformation[] | undefined;
  range: Range;
}
interface ScriptReductionTraceErrorNode extends ScriptReductionTraceNode {
  errors?: ErrorInformation[];
}

export interface ScriptReductionTraceContainerNode<ProgramState>
  extends ScriptReductionTraceNode {
  source: ScriptReductionTraceChildNode<ProgramState>[];
}

export type ScriptReductionTraceChildNode<ProgramState> =
  | ScriptReductionTraceNode
  | ScriptReductionTraceContainerNode<ProgramState>
  | ScriptReductionTraceErrorNode
  | ScriptReductionTraceEvaluationNode<ProgramState>;

export interface TraceSample<ProgramState> {
  range: Range;
  state: ProgramState;
}

export interface ScriptReductionTraceEvaluationNode<ProgramState>
  extends ScriptReductionTraceContainerNode<ProgramState> {
  samples: TraceSample<ProgramState>[];
}

const emptyReductionTraceNode = (range: Range) => ({
  bytecode: Uint8Array.of(),
  range
});

/**
 * Aggregate instructions to build groups of non-malformed instructions.
 *
 * --- TODO: delete old stuff below? ––-
 *
 * So users can write constructions like `OP_PUSHBYTES_2 0x0102` which will
 * evaluate successfully, but instructions which must read over a new-line to
 * make sense (e.g. `OP_PUSHBYTES_2\n0x0102`) should error. This allows for a
 * nice omniscient-debugging experience.
 *
 * **This makes new lines important in evaluations.** However, things
 * can only "break" when new lines are inserted, not when they are removed (e.g.
 * if a script is "minified" to a single line for deployment.)
 *
 * **Implementation note**
 * This method aggregates arrays of instructions by line... a little like
 * Automatic Semicolon Insertion in ECMAScript. 👀 In fact, that's a good
 * sign that we're missing a useful language construct here. Maybe instead
 * of this algorithm, we need a new type of wrapper in the language to indicate
 * that bytecode segments are intended to go together.
 *
 * Interestingly, we already use "Containers" in both pushes and evaluations, so
 * this might be quite easy. E.g. wrapping with `()` or `{}`. However, we also
 * want disassembled instructions to be valid input in BTL, so some form of this
 * line-based logic will still be required unless we also change script
 * disassembly form. E.g. instead of `OP_PUSHBYTES_2 0x0102`, something like
 * `(OP_PUSHBYTES_2 0x0102)` or `<0x0102>`. This is something to consider in
 * future versions.
 */
// tslint:disable-next-line: cyclomatic-complexity
const aggregatedParseReductionTraceNodes = <Opcodes>(
  nodes: readonly ScriptReductionTraceNode[]
): InstructionAggregationResult<Opcodes> => {
  const aggregations: InstructionAggregation<Opcodes>[] = [];
  // eslint-disable-next-line functional/no-let
  let ip = 0;
  // eslint-disable-next-line functional/no-let, init-declarations
  let incomplete: { bytecode: Uint8Array; range: Range } | undefined;
  for (const node of nodes) {
    const bytecode =
      incomplete === undefined
        ? node.bytecode
        : flattenBinArray([incomplete.bytecode, node.bytecode]);
    const range =
      incomplete === undefined
        ? node.range
        : mergeRanges([incomplete.range, node.range]);
    // tslint:disable-next-line: no-expression-statement
    incomplete = undefined;
    const parsed = parseBytecode<Opcodes>(bytecode);
    // tslint:disable-next-line: no-if-statement
    if (parsed.length === 0) {
      // tslint:disable-next-line: no-expression-statement
      aggregations.push({
        instructions: [],
        lastIp: ip,
        range
      });
      // tslint:disable-next-line: no-if-statement
    } else if (authenticationInstructionsAreNotMalformed(parsed)) {
      // tslint:disable-next-line: no-expression-statement
      ip = ip + parsed.length;
      // tslint:disable-next-line: no-expression-statement
      aggregations.push({
        instructions: parsed,
        lastIp: ip,
        range
      });
    } else {
      // tslint:disable-next-line: no-expression-statement
      incomplete = { bytecode, range };
    }
  }
  return {
    aggregations,
    success: true,
    ...(incomplete === undefined
      ? undefined
      : {
          remainingBytecode: incomplete.bytecode,
          remainingRange: incomplete.range,
          success: false
        })
  };
};

/**
 * Evaluate an array of `InstructionAggregation`s with the provided
 * `AuthenticationVirtualMachine`, matching the results back to their source
 * ranges.
 */
export const evaluateInstructionAggregations = <
  Opcodes,
  ProgramState extends MinimumProgramState<Opcodes> & { error?: string }
>(
  aggregations: InstructionAggregation<Opcodes>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vm: AuthenticationVirtualMachine<any, ProgramState>,
  getState: (instructions: AuthenticationInstruction<Opcodes>[]) => ProgramState
): InstructionAggregationEvaluationResult<ProgramState> => {
  const nonEmptyAggregations = aggregations.filter(
    aggregation => aggregation.instructions.length > 0
  );
  const evaluationPlan = nonEmptyAggregations.reduce<{
    breakpoints: { ip: number; range: Range }[];
    instructions: AuthenticationInstruction<Opcodes>[];
  }>(
    (plan, aggregation) => {
      const instructions = [...plan.instructions, ...aggregation.instructions];
      return {
        breakpoints: [
          ...plan.breakpoints,
          { ip: aggregation.lastIp, range: aggregation.range }
        ],
        instructions
      };
    },
    { breakpoints: [], instructions: [] }
  );
  const trace = vm.stateDebug(getState(evaluationPlan.instructions));
  const samples = evaluationPlan.breakpoints.map<
    EvaluationSample<ProgramState>
  >(breakpoint => ({
    range: breakpoint.range,
    state: trace[breakpoint.ip - 1]
  }));
  const firstInvalidSample = samples.findIndex(
    sample => sample.state === undefined
  );
  const errorSample =
    (samples[firstInvalidSample - 1] as
      | EvaluationSample<ProgramState>
      | undefined) ??
    (samples[firstInvalidSample] as EvaluationSample<ProgramState> | undefined);
  return errorSample === undefined
    ? {
        samples: samples as EvaluationSampleValid<ProgramState>[],
        success: true
      }
    : {
        errors: [
          {
            error:
              errorSample.state === undefined
                ? `Failed to reduce evaluation: vm.debug produced no valid program states.`
                : `Failed to reduce evaluation: ${errorSample.state.error}`,
            range: errorSample.range
          }
        ],
        samples,
        success: false
      };
};

/**
 * Incrementally evaluate an array of `ScriptReductionTraceNode`s, returning a
 * trace of the evaluation and the resulting top stack item (`evaluationResult`)
 * if successful.
 *
 * @param nodes an array of reduced nodes
 * @param vm the `AuthenticationVirtualMachine` to use in the evaluation
 * @param getState a method which should generate a new ProgramState given an
 * array of `instructions`
 */
// tslint:disable-next-line: cyclomatic-complexity
export const sampledEvaluateReductionTraceNodes = <
  Opcodes,
  ProgramState extends MinimumProgramState<Opcodes> &
    StackState & { error?: string }
>(
  nodes: ScriptReductionTraceNode[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vm: AuthenticationVirtualMachine<any, ProgramState>,
  getState: (instructions: AuthenticationInstruction<Opcodes>[]) => ProgramState
): SampledEvaluationResult<ProgramState> => {
  const parsed = aggregatedParseReductionTraceNodes<Opcodes>(nodes);
  const evaluated = evaluateInstructionAggregations(
    parsed.aggregations,
    vm,
    getState
  );
  // tslint:disable-next-line: no-if-statement
  if (parsed.success && evaluated.success) {
    const samples =
      evaluated.samples.length > 0
        ? evaluated.samples
        : [{ range: parsed.aggregations[0].range, state: getState([]) }];
    const lastSample = samples[samples.length - 1];
    const lastStackItem = lastSample.state.stack[
      lastSample.state.stack.length - 1
    ] as Uint8Array | undefined;
    const evaluationResult =
      lastStackItem === undefined ? Uint8Array.of() : lastStackItem.slice();
    return {
      bytecode: evaluationResult,
      samples,
      success: true
    };
  }
  return {
    bytecode: Uint8Array.of(),
    errors: [
      ...(parsed.success
        ? []
        : [
            {
              error: `A sample is malformed and cannot be evaluated: ${disassembleBytecode(
                OpcodesCommon,
                parsed.remainingBytecode
              )}`,
              range: parsed.remainingRange
            }
          ]),
      ...(evaluated.success ? [] : evaluated.errors)
    ],
    samples: evaluated.samples,
    success: false
  };
};

/**
 * This method will throw an error if provided a `compiledScript` with
 * compilation errors. To check for compilation errors, use `getCompileErrors`.
 * @param compiledScript the `CompiledScript` to reduce
 * @param vm the `AuthenticationVirtualMachine` to use for evaluations
 * @param createState a method which returns the base `ProgramState` used when initializing evaluations
 */
export const reduceScript = <
  ProgramState extends StackState & MinimumProgramState<Opcodes>,
  Opcodes
>(
  compiledScript: ResolvedScript,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vm?: AuthenticationVirtualMachine<any, ProgramState>,
  createState?: (
    instructions: AuthenticationInstruction<Opcodes>[]
  ) => ProgramState
): ScriptReductionTraceContainerNode<ProgramState> => {
  const source = compiledScript.map<
    ScriptReductionTraceChildNode<ProgramState>
    // tslint:disable-next-line: cyclomatic-complexity
  >(segment => {
    // tslint:disable-next-line: switch-default
    switch (segment.type) {
      case 'bytecode':
        return { bytecode: segment.value, range: segment.range };
      case 'push': {
        // tslint:disable-next-line: no-if-statement
        if (segment.value.length === 0) {
          return emptyReductionTraceNode(segment.range);
        }
        const push = reduceScript(segment.value, vm, createState);
        const bytecode = encodeDataPush(push.bytecode);
        return {
          bytecode,
          ...(push.errors ? { errors: push.errors } : undefined),
          range: segment.range,
          source: [push]
        };
      }
      case 'evaluation': {
        // tslint:disable-next-line: no-if-statement
        if (segment.value.length === 0) {
          return emptyReductionTraceNode(segment.range);
        }
        // tslint:disable-next-line: no-if-statement
        if (typeof vm === 'undefined' || typeof createState === 'undefined') {
          return {
            errors: [
              {
                error:
                  'Both a VM and a createState method are required to reduce evaluations.',
                range: segment.range
              }
            ],
            ...emptyReductionTraceNode(segment.range)
          };
        }
        const reductionTrace = reduceScript(segment.value, vm, createState);
        const evaluated = sampledEvaluateReductionTraceNodes(
          reductionTrace.source,
          vm,
          createState
        );
        const errors = [
          ...(reductionTrace.errors === undefined ? [] : reductionTrace.errors),
          ...(evaluated.success ? [] : evaluated.errors)
        ];
        return {
          ...(errors.length > 0
            ? {
                errors,
                ...emptyReductionTraceNode(segment.range)
              }
            : {
                bytecode: evaluated.bytecode,
                range: segment.range
              }),
          samples: evaluated.samples,
          source: [reductionTrace]
        };
      }
      case 'comment':
        return emptyReductionTraceNode(segment.range);
      case 'error':
        return {
          errors: [
            {
              error: `Tried to reduce a BTL script with resolution errors: ${segment.value}`,
              range: segment.range
            }
          ],
          ...emptyReductionTraceNode(segment.range)
        };
      default:
        return new Error(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `"${(segment as any).type}" is not a known segment type.`
        ) as never;
    }
  });
  const reduction = source.reduce<{
    bytecode: Uint8Array[];
    errors?: ErrorInformation[] | undefined;
    ranges: Range[];
  }>(
    (all, segment) => ({
      bytecode: [...all.bytecode, segment.bytecode],
      ranges: [...all.ranges, segment.range],
      ...(all.errors !== undefined || segment.errors !== undefined
        ? {
            errors: [
              ...(all.errors === undefined ? [] : all.errors),
              ...(segment.errors === undefined ? [] : segment.errors)
            ]
          }
        : undefined)
    }),
    { bytecode: [], ranges: [] }
  );
  return {
    ...(reduction.errors ? { errors: reduction.errors } : undefined),
    bytecode: flattenBinArray(reduction.bytecode),
    range: mergeRanges(reduction.ranges),
    source
  };
};

export interface InstructionAggregation<Opcodes> {
  instructions: AuthenticationInstruction<Opcodes>[];
  lastIp: number;
  range: Range;
}

export interface InstructionAggregationSuccess<Opcodes> {
  aggregations: InstructionAggregation<Opcodes>[];
  success: true;
}

export interface InstructionAggregationError<Opcodes> {
  aggregations: InstructionAggregation<Opcodes>[];
  remainingBytecode: Uint8Array;
  remainingRange: Range;
  success: false;
}

export type InstructionAggregationResult<Opcodes> =
  | InstructionAggregationSuccess<Opcodes>
  | InstructionAggregationError<Opcodes>;

export interface EvaluationSample<ProgramState> {
  range: Range;
  state: ProgramState | undefined;
}

export interface EvaluationSampleValid<ProgramState> {
  range: Range;
  state: ProgramState;
}

export interface InstructionAggregationEvaluationError<ProgramState> {
  errors: ErrorInformation[];
  samples: EvaluationSample<ProgramState>[];
  success: false;
}

export interface InstructionAggregationEvaluationSuccess<ProgramState> {
  samples: EvaluationSampleValid<ProgramState>[];
  success: true;
}

type InstructionAggregationEvaluationResult<ProgramState> =
  | InstructionAggregationEvaluationError<ProgramState>
  | InstructionAggregationEvaluationSuccess<ProgramState>;

export interface SampledEvaluationSuccess<ProgramState> {
  bytecode: Uint8Array;
  samples: EvaluationSampleValid<ProgramState>[];
  success: true;
}
export interface SampledEvaluationError<ProgramState> {
  bytecode: Uint8Array;
  errors: ErrorInformation[];
  samples: EvaluationSample<ProgramState>[];
  success: false;
}

export type SampledEvaluationResult<ProgramState> =
  | SampledEvaluationSuccess<ProgramState>
  | SampledEvaluationError<ProgramState>;

export interface FlattenedTraceSample<ProgramState>
  extends TraceSample<ProgramState> {
  /**
   * The nesting-depth of this sample. (E.g. the first level of evaluation has a
   * depth of `1`, an evaluation inside of it will produce samples with a depth
   * of `2`, etc.)
   */
  depth: number;
}
