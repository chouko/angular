/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AST, BoundTarget, DYNAMIC_TYPE, ExpressionType, ExternalExpr, ImplicitReceiver, PropertyRead, TmplAstBoundAttribute, TmplAstBoundText, TmplAstElement, TmplAstNode, TmplAstReference, TmplAstTemplate, TmplAstTextAttribute, TmplAstVariable, Type} from '@angular/compiler';
import * as ts from 'typescript';

import {NOOP_DEFAULT_IMPORT_RECORDER, Reference, ReferenceEmitter} from '../../imports';
import {ClassDeclaration} from '../../reflection';
import {ImportManager, translateExpression, translateType} from '../../translator';

import {TypeCheckBlockMetadata, TypeCheckableDirectiveMeta} from './api';
import {astToTypescript} from './expression';

/**
 * Given a `ts.ClassDeclaration` for a component, and metadata regarding that component, compose a
 * "type check block" function.
 *
 * When passed through TypeScript's TypeChecker, type errors that arise within the type check block
 * function indicate issues in the template itself.
 *
 * @param node the TypeScript node for the component class.
 * @param meta metadata about the component's template and the function being generated.
 * @param importManager an `ImportManager` for the file into which the TCB will be written.
 */
export function generateTypeCheckBlock(
    node: ClassDeclaration<ts.ClassDeclaration>, meta: TypeCheckBlockMetadata,
    importManager: ImportManager, refEmitter: ReferenceEmitter): ts.FunctionDeclaration {
  const tcb = new Context(meta.boundTarget, node.getSourceFile(), importManager, refEmitter);
  const scope = Scope.forNodes(tcb, null, tcb.boundTarget.target.template !);

  return ts.createFunctionDeclaration(
      /* decorators */ undefined,
      /* modifiers */ undefined,
      /* asteriskToken */ undefined,
      /* name */ meta.fnName,
      /* typeParameters */ node.typeParameters,
      /* parameters */[tcbCtxParam(node)],
      /* type */ undefined,
      /* body */ ts.createBlock([ts.createIf(ts.createTrue(), scope.renderToBlock())]));
}

/**
 * A code generation operation that's involved in the construction of a Type Check Block.
 *
 * The generation of a TCB is non-linear. Bindings within a template may result in the need to
 * construct certain types earlier than they otherwise would be constructed. That is, if the
 * generation of a TCB for a template is broken down into specific operations (constructing a
 * directive, extracting a variable from a let- operation, etc), then it's possible for operations
 * earlier in the sequence to depend on operations which occur later in the sequence.
 *
 * `TcbOp` abstracts the different types of operations which are required to convert a template into
 * a TCB. This allows for two phases of processing for the template, where 1) a linear sequence of
 * `TcbOp`s is generated, and then 2) these operations are executed, not necessarily in linear
 * order.
 *
 * Each `TcbOp` may insert statements into the body of the TCB, and also optionally return a
 * `ts.Expression` which can be used to reference the operation's result.
 */
abstract class TcbOp { abstract execute(): ts.Expression|null; }

/**
 * A `TcbOp` which creates an expression for a native DOM element (or web component) from a
 * `TmplAstElement`.
 *
 * Executing this operation returns a reference to the element variable.
 */
class TcbElementOp extends TcbOp {
  constructor(private tcb: Context, private scope: Scope, private element: TmplAstElement) {
    super();
  }

  execute(): ts.Identifier {
    const id = this.tcb.allocateId();
    // Add the declaration of the element using document.createElement.
    this.scope.addStatement(tsCreateVariable(id, tsCreateElement(this.element.name)));
    return id;
  }
}

/**
 * A `TcbOp` which creates an expression for particular let- `TmplAstVariable` on a
 * `TmplAstTemplate`'s context.
 *
 * Executing this operation returns a reference to the variable variable (lol).
 */
class TcbVariableOp extends TcbOp {
  constructor(
      private tcb: Context, private scope: Scope, private template: TmplAstTemplate,
      private variable: TmplAstVariable) {
    super();
  }

  execute(): ts.Identifier {
    // Look for a context variable for the template.
    const ctx = this.scope.resolve(this.template);

    // Allocate an identifier for the TmplAstVariable, and initialize it to a read of the variable
    // on the template context.
    const id = this.tcb.allocateId();
    const initializer = ts.createPropertyAccess(
        /* expression */ ctx,
        /* name */ this.variable.value);

    // Declare the variable, and return its identifier.
    this.scope.addStatement(tsCreateVariable(id, initializer));
    return id;
  }
}

/**
 * A `TcbOp` which generates a variable for a `TmplAstTemplate`'s context.
 *
 * Executing this operation returns a reference to the template's context variable.
 */
class TcbTemplateContextOp extends TcbOp {
  constructor(private tcb: Context, private scope: Scope) { super(); }

  execute(): ts.Identifier {
    // Allocate a template ctx variable and declare it with an 'any' type. The type of this variable
    // may be narrowed as a result of template guard conditions.
    const ctx = this.tcb.allocateId();
    const type = ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    this.scope.addStatement(tsDeclareVariable(ctx, type));
    return ctx;
  }
}

/**
 * A `TcbOp` which descends into a `TmplAstTemplate`'s children and generates type-checking code for
 * them.
 *
 * This operation wraps the children's type-checking code in an `if` block, which may include one
 * or more type guard conditions that narrow types within the template body.
 */
class TcbTemplateBodyOp extends TcbOp {
  constructor(private tcb: Context, private scope: Scope, private template: TmplAstTemplate) {
    super();
  }
  execute(): null {
    // Create a new Scope for the template. This constructs the list of operations for the template
    // children, as well as tracks bindings within the template.
    const tmplScope = Scope.forNodes(this.tcb, this.scope, this.template);

    // An `if` will be constructed, within which the template's children will be type checked. The
    // `if` is used for two reasons: it creates a new syntactic scope, isolating variables declared
    // in the template's TCB from the outer context, and it allows any directives on the templates
    // to perform type narrowing of either expressions or the template's context.
    //
    // The guard is the `if` block's condition. It's usually set to `true` but directives that exist
    // on the template can trigger extra guard expressions that serve to narrow types within the
    // `if`. `guard` is calculated by starting with `true` and adding other conditions as needed.
    // Collect these into `guards` by processing the directives.
    const directiveGuards: ts.Expression[] = [];

    const directives = this.tcb.boundTarget.getDirectivesOfNode(this.template);
    if (directives !== null) {
      for (const dir of directives) {
        const dirInstId = this.scope.resolve(this.template, dir);
        const dirId = this.tcb.reference(dir.ref);

        // There are two kinds of guards. Template guards (ngTemplateGuards) allow type narrowing of
        // the expression passed to an @Input of the directive. Scan the directive to see if it has
        // any template guards, and generate them if needed.
        dir.ngTemplateGuards.forEach(inputName => {
          // For each template guard function on the directive, look for a binding to that input.
          const boundInput = this.template.inputs.find(i => i.name === inputName) ||
              this.template.templateAttrs.find(
                  (i: TmplAstTextAttribute | TmplAstBoundAttribute): i is TmplAstBoundAttribute =>
                      i instanceof TmplAstBoundAttribute && i.name === inputName);
          if (boundInput !== undefined) {
            // If there is such a binding, generate an expression for it.
            const expr = tcbExpression(boundInput.value, this.tcb, this.scope);
            // Call the guard function on the directive with the directive instance and that
            // expression.
            const guardInvoke = tsCallMethod(dirId, `ngTemplateGuard_${inputName}`, [
              dirInstId,
              expr,
            ]);
            directiveGuards.push(guardInvoke);
          }
        });

        // The second kind of guard is a template context guard. This guard narrows the template
        // rendering context variable `ctx`.
        if (dir.hasNgTemplateContextGuard) {
          const ctx = this.scope.resolve(this.template);
          const guardInvoke = tsCallMethod(dirId, 'ngTemplateContextGuard', [dirInstId, ctx]);
          directiveGuards.push(guardInvoke);
        }
      }
    }

    // By default the guard is simply `true`.
    let guard: ts.Expression = ts.createTrue();

    // If there are any guards from directives, use them instead.
    if (directiveGuards.length > 0) {
      // Pop the first value and use it as the initializer to reduce(). This way, a single guard
      // will be used on its own, but two or more will be combined into binary AND expressions.
      guard = directiveGuards.reduce(
          (expr, dirGuard) =>
              ts.createBinary(expr, ts.SyntaxKind.AmpersandAmpersandToken, dirGuard),
          directiveGuards.pop() !);
    }

    // Construct the `if` block for the template with the generated guard expression. The body of
    // the `if` block is created by rendering the template's `Scope.
    const tmplIf = ts.createIf(
        /* expression */ guard,
        /* thenStatement */ tmplScope.renderToBlock());
    this.scope.addStatement(tmplIf);
    return null;
  }
}

/**
 * A `TcbOp` which renders a text binding (interpolation) into the TCB.
 *
 * Executing this operation returns nothing.
 */
class TcbTextInterpolationOp extends TcbOp {
  constructor(private tcb: Context, private scope: Scope, private binding: TmplAstBoundText) {
    super();
  }

  execute(): null {
    const expr = tcbExpression(this.binding.value, this.tcb, this.scope);
    this.scope.addStatement(ts.createExpressionStatement(expr));
    return null;
  }
}

/**
 * A `TcbOp` which constructs an instance of a directive with types inferred from its inputs, which
 * also checks the bindings to the directive in the process.
 *
 * Executing this operation returns a reference to the directive instance variable with its inferred
 * type.
 */
class TcbDirectiveOp extends TcbOp {
  constructor(
      private tcb: Context, private scope: Scope, private node: TmplAstTemplate|TmplAstElement,
      private dir: TypeCheckableDirectiveMeta) {
    super();
  }

  execute(): ts.Identifier {
    const id = this.tcb.allocateId();
    // Process the directive and construct expressions for each of its bindings.
    const bindings = tcbGetInputBindingExpressions(this.node, this.dir, this.tcb, this.scope);

    // Call the type constructor of the directive to infer a type, and assign the directive
    // instance.
    const typeCtor = tcbCallTypeCtor(this.node, this.dir, this.tcb, this.scope, bindings);
    this.scope.addStatement(tsCreateVariable(id, typeCtor));
    return id;
  }
}

/**
 * A `TcbOp` which generates code to check "unclaimed inputs" - bindings on an element which were
 * not attributed to any directive or component, and are instead processed against the HTML element
 * itself.
 *
 * Executing this operation returns nothing.
 */
class TcbUnclaimedInputsOp extends TcbOp {
  constructor(
      private tcb: Context, private scope: Scope, private element: TmplAstElement,
      private inputs: Set<string>) {
    super();
  }

  execute(): null {
    // `this.inputs` contains only those bindings not matched by any directive. These bindings go to
    // the element itself.
    const elId = this.scope.resolve(this.element);
    this.inputs.forEach(name => {
      // TODO(alxhub): this could be more efficient.
      const binding = this.element.inputs.find(input => input.name === name) !;
      const expr = tcbExpression(binding.value, this.tcb, this.scope);
      const prop = ts.createPropertyAccess(elId, name);
      const assign = ts.createBinary(prop, ts.SyntaxKind.EqualsToken, expr);
      this.scope.addStatement(ts.createStatement(assign));
    });

    return null;
  }
}

/**
 * Value used to break a circular reference between `TcbOp`s.
 *
 * This value is returned whenever `TcbOp`s have a circular dependency. The expression is a non-null
 * assertion of the null value (in TypeScript, the expression `null!`). This construction will infer
 * the least narrow type for whatever it's assigned to.
 */
const INFER_TYPE_FOR_CIRCULAR_OP_EXPR = ts.createNonNullExpression(ts.createNull());

/**
 * Overall generation context for the type check block.
 *
 * `Context` handles operations during code generation which are global with respect to the whole
 * block. It's responsible for variable name allocation and management of any imports needed. It
 * also contains the template metadata itself.
 */
class Context {
  private nextId = 1;

  constructor(
      readonly boundTarget: BoundTarget<TypeCheckableDirectiveMeta>,
      private sourceFile: ts.SourceFile, private importManager: ImportManager,
      private refEmitter: ReferenceEmitter) {}

  /**
   * Allocate a new variable name for use within the `Context`.
   *
   * Currently this uses a monotonically increasing counter, but in the future the variable name
   * might change depending on the type of data being stored.
   */
  allocateId(): ts.Identifier { return ts.createIdentifier(`_t${this.nextId++}`); }

  /**
   * Generate a `ts.Expression` that references the given node.
   *
   * This may involve importing the node into the file if it's not declared there already.
   */
  reference(ref: Reference<ts.Node>): ts.Expression {
    const ngExpr = this.refEmitter.emit(ref, this.sourceFile);

    // Use `translateExpression` to convert the `Expression` into a `ts.Expression`.
    return translateExpression(ngExpr, this.importManager, NOOP_DEFAULT_IMPORT_RECORDER);
  }

  /**
   * Generate a `ts.TypeNode` that references the given node as a type.
   *
   * This may involve importing the node into the file if it's not declared there already.
   */
  referenceType(ref: Reference<ts.Node>): ts.TypeNode {
    const ngExpr = this.refEmitter.emit(ref, this.sourceFile);

    // Create an `ExpressionType` from the `Expression` and translate it via `translateType`.
    return translateType(new ExpressionType(ngExpr), this.importManager);
  }

  /**
   * Generate a `ts.TypeNode` that references a given type from '@angular/core'.
   *
   * This will involve importing the type into the file, and will also add a number of generic type
   * parameters (using `any`) as requested.
   */
  referenceCoreType(name: string, typeParamCount: number = 0): ts.TypeNode {
    const external = new ExternalExpr({
      moduleName: '@angular/core',
      name,
    });
    let typeParams: Type[]|null = null;
    if (typeParamCount > 0) {
      typeParams = [];
      for (let i = 0; i < typeParamCount; i++) {
        typeParams.push(DYNAMIC_TYPE);
      }
    }
    return translateType(new ExpressionType(external, null, typeParams), this.importManager);
  }
}

/**
 * Local scope within the type check block for a particular template.
 *
 * The top-level template and each nested `<ng-template>` have their own `Scope`, which exist in a
 * hierarchy. The structure of this hierarchy mirrors the syntactic scopes in the generated type
 * check block, where each nested template is encased in an `if` structure.
 *
 * As a template's `TcbOp`s are executed in a given `Scope`, statements are added via
 * `addStatement()`. When this processing is complete, the `Scope` can be turned into a `ts.Block`
 * via `renderToBlock()`.
 *
 * If a `TcbOp` requires the output of another, it can call `resolve()`.
 */
class Scope {
  /**
   * A queue of operations which need to be performed to generate the TCB code for this scope.
   *
   * This array can contain either a `TcbOp` which has yet to be executed, or a `ts.Expression|null`
   * representing the memoized result of executing the operation. As operations are executed, their
   * results are written into the `opQueue`, overwriting the original operation.
   *
   * If an operation is in the process of being executed, it is temporarily overwritten here with
   * `INFER_TYPE_FOR_CIRCULAR_OP_EXPR`. This way, if a cycle is encountered where an operation
   * depends transitively on its own result, the inner operation will infer the least narrow type
   * that fits instead. This has the same semantics as TypeScript itself when types are referenced
   * circularly.
   */
  private opQueue: (TcbOp|ts.Expression|null)[] = [];

  /**
   * A map of `TmplAstElement`s to the index of their `TcbElementOp` in the `opQueue`
   */
  private elementOpMap = new Map<TmplAstElement, number>();
  /**
   * A map of maps which tracks the index of `TcbDirectiveOp`s in the `opQueue` for each directive
   * on a `TmplAstElement` or `TmplAstTemplate` node.
   */
  private directiveOpMap =
      new Map<TmplAstElement|TmplAstTemplate, Map<TypeCheckableDirectiveMeta, number>>();

  /**
   * Map of immediately nested <ng-template>s (within this `Scope`) represented by `TmplAstTemplate`
   * nodes to the index of their `TcbTemplateContextOp`s in the `opQueue`.
   */
  private templateCtxOpMap = new Map<TmplAstTemplate, number>();

  /**
   * Map of variables declared on the template that created this `Scope` (represented by
   * `TmplAstVariable` nodes) to the index of their `TcbVariableOp`s in the `opQueue`.
   */
  private varMap = new Map<TmplAstVariable, number>();

  /**
   * Statements for this template.
   *
   * Executing the `TcbOp`s in the `opQueue` populates this array.
   */
  private statements: ts.Statement[] = [];

  private constructor(private tcb: Context, private parent: Scope|null = null) {}

  /**
   * Constructs a `Scope` given either a `TmplAstTemplate` or a list of `TmplAstNode`s.
   *
   * @param tcb the overall context of TCB generation.
   * @param parent the `Scope` of the parent template (if any) or `null` if this is the root
   * `Scope`.
   * @param templateOrNodes either a `TmplAstTemplate` representing the template for which to
   * calculate the `Scope`, or a list of nodes if no outer template object is available.
   */
  static forNodes(
      tcb: Context, parent: Scope|null, templateOrNodes: TmplAstTemplate|(TmplAstNode[])): Scope {
    const scope = new Scope(tcb, parent);

    let children: TmplAstNode[];

    // If given an actual `TmplAstTemplate` instance, then process any additional information it
    // has.
    if (templateOrNodes instanceof TmplAstTemplate) {
      // The template's variable declarations need to be added as `TcbVariableOp`s.
      for (const v of templateOrNodes.variables) {
        const opIndex = scope.opQueue.push(new TcbVariableOp(tcb, scope, templateOrNodes, v)) - 1;
        scope.varMap.set(v, opIndex);
      }
      children = templateOrNodes.children;
    } else {
      children = templateOrNodes;
    }
    for (const node of children) {
      scope.appendNode(node);
    }
    return scope;
  }

  /**
   * Look up a `ts.Expression` representing the value of some operation in the current `Scope`,
   * including any parent scope(s).
   *
   * @param node a `TmplAstNode` of the operation in question. The lookup performed will depend on
   * the type of this node:
   *
   * Assuming `directive` is not present, then `resolve` will return:
   *
   * * `TmplAstElement` - retrieve the expression for the element DOM node
   * * `TmplAstTemplate` - retrieve the template context variable
   * * `TmplAstVariable` - retrieve a template let- variable
   *
   * @param directive if present, a directive type on a `TmplAstElement` or `TmplAstTemplate` to
   * look up instead of the default for an element or template node.
   */
  resolve(
      node: TmplAstElement|TmplAstTemplate|TmplAstVariable,
      directive?: TypeCheckableDirectiveMeta): ts.Expression {
    // Attempt to resolve the operation locally.
    const res = this.resolveLocal(node, directive);
    if (res !== null) {
      return res;
    } else if (this.parent !== null) {
      // Check with the parent.
      return this.parent.resolve(node, directive);
    } else {
      throw new Error(`Could not resolve ${node} / ${directive}`);
    }
  }

  /**
   * Add a statement to this scope.
   */
  addStatement(stmt: ts.Statement): void { this.statements.push(stmt); }

  /**
   * Get a `ts.Block` containing the statements in this scope.
   */
  renderToBlock(): ts.Block {
    for (let i = 0; i < this.opQueue.length; i++) {
      this.executeOp(i);
    }
    return ts.createBlock(this.statements);
  }

  private resolveLocal(
      ref: TmplAstElement|TmplAstTemplate|TmplAstVariable,
      directive?: TypeCheckableDirectiveMeta): ts.Expression|null {
    if (ref instanceof TmplAstVariable && this.varMap.has(ref)) {
      // Resolving a context variable for this template.
      // Execute the `TcbVariableOp` associated with the `TmplAstVariable`.
      return this.resolveOp(this.varMap.get(ref) !);
    } else if (
        ref instanceof TmplAstTemplate && directive === undefined &&
        this.templateCtxOpMap.has(ref)) {
      // Resolving the context of the given sub-template.
      // Execute the `TcbTemplateContextOp` for the template.
      return this.resolveOp(this.templateCtxOpMap.get(ref) !);
    } else if (
        (ref instanceof TmplAstElement || ref instanceof TmplAstTemplate) &&
        directive !== undefined && this.directiveOpMap.has(ref)) {
      // Resolving a directive on an element or sub-template.
      const dirMap = this.directiveOpMap.get(ref) !;
      if (dirMap.has(directive)) {
        return this.resolveOp(dirMap.get(directive) !);
      } else {
        return null;
      }
    } else if (ref instanceof TmplAstElement && this.elementOpMap.has(ref)) {
      // Resolving the DOM node of an element in this template.
      return this.resolveOp(this.elementOpMap.get(ref) !);
    } else {
      return null;
    }
  }

  /**
   * Like `executeOp`, but assert that the operation actually returned `ts.Expression`.
   */
  private resolveOp(opIndex: number): ts.Expression {
    const res = this.executeOp(opIndex);
    if (res === null) {
      throw new Error(`Error resolving operation, got null`);
    }
    return res;
  }

  /**
   * Execute a particular `TcbOp` in the `opQueue`.
   *
   * This method replaces the operation in the `opQueue` with the result of execution (once done)
   * and also protects against a circular dependency from the operation to itself by temporarily
   * setting the operation's result to a special expression.
   */
  private executeOp(opIndex: number): ts.Expression|null {
    const op = this.opQueue[opIndex];
    if (!(op instanceof TcbOp)) {
      return op;
    }

    // Set the result of the operation in the queue to a special expression. If executing this
    // operation results in a circular dependency, this will break the cycle and infer the least
    // narrow type where needed (which is how TypeScript deals with circular dependencies in types).
    this.opQueue[opIndex] = INFER_TYPE_FOR_CIRCULAR_OP_EXPR;
    const res = op.execute();
    // Once the operation has finished executing, it's safe to cache the real result.
    this.opQueue[opIndex] = res;
    return res;
  }

  private appendNode(node: TmplAstNode): void {
    if (node instanceof TmplAstElement) {
      const opIndex = this.opQueue.push(new TcbElementOp(this.tcb, this, node)) - 1;
      this.elementOpMap.set(node, opIndex);
      this.appendDirectivesAndInputsOfNode(node);
      for (const child of node.children) {
        this.appendNode(child);
      }
    } else if (node instanceof TmplAstTemplate) {
      // Template children are rendered in a child scope.
      this.appendDirectivesAndInputsOfNode(node);
      const ctxIndex = this.opQueue.push(new TcbTemplateContextOp(this.tcb, this)) - 1;
      this.templateCtxOpMap.set(node, ctxIndex);
      this.opQueue.push(new TcbTemplateBodyOp(this.tcb, this, node));
    } else if (node instanceof TmplAstBoundText) {
      this.opQueue.push(new TcbTextInterpolationOp(this.tcb, this, node));
    }
  }

  private appendDirectivesAndInputsOfNode(node: TmplAstElement|TmplAstTemplate): void {
    // Collect all the inputs on the element.
    const elementInputs = new Set<string>(node.inputs.map(input => input.name));
    const directives = this.tcb.boundTarget.getDirectivesOfNode(node);
    if (directives === null || directives.length === 0) {
      // If there are no directives, then all inputs are unclaimed inputs, so queue an operation
      // to add them if needed.
      if (node instanceof TmplAstElement && elementInputs.size > 0) {
        this.opQueue.push(new TcbUnclaimedInputsOp(this.tcb, this, node, elementInputs));
      }
      return;
    }

    const dirMap = new Map<TypeCheckableDirectiveMeta, number>();
    for (const dir of directives) {
      const dirIndex = this.opQueue.push(new TcbDirectiveOp(this.tcb, this, node, dir)) - 1;
      dirMap.set(dir, dirIndex);
    }
    this.directiveOpMap.set(node, dirMap);

    // After expanding the directives, we might need to queue an operation to check any unclaimed
    // inputs.
    if (node instanceof TmplAstElement) {
      // Go through the directives and remove any inputs that it claims from `elementInputs`.
      for (const dir of directives) {
        for (const fieldName of Object.keys(dir.inputs)) {
          const value = dir.inputs[fieldName];
          elementInputs.delete(Array.isArray(value) ? value[0] : value);
        }
      }

      // If any are left over, queue a `TcbUnclaimedInputsOp` to check them.
      if (elementInputs.size > 0) {
        this.opQueue.push(new TcbUnclaimedInputsOp(this.tcb, this, node, elementInputs));
      }
    }
  }
}

/**
 * Create the `ctx` parameter to the top-level TCB function.
 *
 * This is a parameter with a type equivalent to the component type, with all generic type
 * parameters listed (without their generic bounds).
 */
function tcbCtxParam(node: ts.ClassDeclaration): ts.ParameterDeclaration {
  let typeArguments: ts.TypeNode[]|undefined = undefined;
  // Check if the component is generic, and pass generic type parameters if so.
  if (node.typeParameters !== undefined) {
    typeArguments =
        node.typeParameters.map(param => ts.createTypeReferenceNode(param.name, undefined));
  }
  const type = ts.createTypeReferenceNode(node.name !, typeArguments);
  return ts.createParameter(
      /* decorators */ undefined,
      /* modifiers */ undefined,
      /* dotDotDotToken */ undefined,
      /* name */ 'ctx',
      /* questionToken */ undefined,
      /* type */ type,
      /* initializer */ undefined);
}

/**
 * Process an `AST` expression and convert it into a `ts.Expression`, generating references to the
 * correct identifiers in the current scope.
 */
function tcbExpression(ast: AST, tcb: Context, scope: Scope): ts.Expression {
  // `astToTypescript` actually does the conversion. A special resolver `tcbResolve` is passed which
  // interprets specific expression nodes that interact with the `ImplicitReceiver`. These nodes
  // actually refer to identifiers within the current scope.
  return astToTypescript(ast, (ast) => tcbResolve(ast, tcb, scope));
}

/**
 * Call the type constructor of a directive instance on a given template node, inferring a type for
 * the directive instance from any bound inputs.
 */
function tcbCallTypeCtor(
    el: TmplAstElement | TmplAstTemplate, dir: TypeCheckableDirectiveMeta, tcb: Context,
    scope: Scope, bindings: TcbBinding[]): ts.Expression {
  const dirClass = tcb.reference(dir.ref);

  // Construct an array of `ts.PropertyAssignment`s for each input of the directive that has a
  // matching binding.
  const members = bindings.map(b => ts.createPropertyAssignment(b.field, b.expression));

  // Call the `ngTypeCtor` method on the directive class, with an object literal argument created
  // from the matched inputs.
  return tsCallMethod(
      /* receiver */ dirClass,
      /* methodName */ 'ngTypeCtor',
      /* args */[ts.createObjectLiteral(members)]);
}

interface TcbBinding {
  field: string;
  property: string;
  expression: ts.Expression;
}

function tcbGetInputBindingExpressions(
    el: TmplAstElement | TmplAstTemplate, dir: TypeCheckableDirectiveMeta, tcb: Context,
    scope: Scope): TcbBinding[] {
  const bindings: TcbBinding[] = [];
  // `dir.inputs` is an object map of field names on the directive class to property names.
  // This is backwards from what's needed to match bindings - a map of properties to field names
  // is desired. Invert `dir.inputs` into `propMatch` to create this map.
  const propMatch = new Map<string, string>();
  const inputs = dir.inputs;
  Object.keys(inputs).forEach(key => {
    Array.isArray(inputs[key]) ? propMatch.set(inputs[key][0], key) :
                                 propMatch.set(inputs[key] as string, key);
  });

  el.inputs.forEach(processAttribute);
  if (el instanceof TmplAstTemplate) {
    el.templateAttrs.forEach(processAttribute);
  }
  return bindings;

  /**
   * Add a binding expression to the map for each input/template attribute of the directive that has
   * a matching binding.
   */
  function processAttribute(attr: TmplAstBoundAttribute | TmplAstTextAttribute): void {
    if (attr instanceof TmplAstBoundAttribute && propMatch.has(attr.name)) {
      // Produce an expression representing the value of the binding.
      const expr = tcbExpression(attr.value, tcb, scope);
      // Call the callback.
      bindings.push({
        property: attr.name,
        field: propMatch.get(attr.name) !,
        expression: expr,
      });
    }
  }
}

/**
 * Create an expression which instantiates an element by its HTML tagName.
 *
 * Thanks to narrowing of `document.createElement()`, this expression will have its type inferred
 * based on the tag name, including for custom elements that have appropriate .d.ts definitions.
 */
function tsCreateElement(tagName: string): ts.Expression {
  const createElement = ts.createPropertyAccess(
      /* expression */ ts.createIdentifier('document'), 'createElement');
  return ts.createCall(
      /* expression */ createElement,
      /* typeArguments */ undefined,
      /* argumentsArray */[ts.createLiteral(tagName)]);
}

/**
 * Create a `ts.VariableStatement` which declares a variable without explicit initialization.
 *
 * The initializer `null!` is used to bypass strict variable initialization checks.
 *
 * Unlike with `tsCreateVariable`, the type of the variable is explicitly specified.
 */
function tsDeclareVariable(id: ts.Identifier, type: ts.TypeNode): ts.VariableStatement {
  const decl = ts.createVariableDeclaration(
      /* name */ id,
      /* type */ type,
      /* initializer */ ts.createNonNullExpression(ts.createNull()));
  return ts.createVariableStatement(
      /* modifiers */ undefined,
      /* declarationList */[decl]);
}

/**
 * Create a `ts.VariableStatement` that initializes a variable with a given expression.
 *
 * Unlike with `tsDeclareVariable`, the type of the variable is inferred from the initializer
 * expression.
 */
function tsCreateVariable(id: ts.Identifier, initializer: ts.Expression): ts.VariableStatement {
  const decl = ts.createVariableDeclaration(
      /* name */ id,
      /* type */ undefined,
      /* initializer */ initializer);
  return ts.createVariableStatement(
      /* modifiers */ undefined,
      /* declarationList */[decl]);
}

/**
 * Construct a `ts.CallExpression` that calls a method on a receiver.
 */
function tsCallMethod(
    receiver: ts.Expression, methodName: string, args: ts.Expression[] = []): ts.CallExpression {
  const methodAccess = ts.createPropertyAccess(receiver, methodName);
  return ts.createCall(
      /* expression */ methodAccess,
      /* typeArguments */ undefined,
      /* argumentsArray */ args);
}

/**
 * Resolve an `AST` expression within the given scope.
 *
 * Some `AST` expressions refer to top-level concepts (references, variables, the component
 * context). This method assists in resolving those.
 */
function tcbResolve(ast: AST, tcb: Context, scope: Scope): ts.Expression|null {
  if (ast instanceof PropertyRead && ast.receiver instanceof ImplicitReceiver) {
    // Check whether the template metadata has bound a target for this expression. If so, then
    // resolve that target. If not, then the expression is referencing the top-level component
    // context.
    const binding = tcb.boundTarget.getExpressionTarget(ast);
    if (binding !== null) {
      // This expression has a binding to some variable or reference in the template. Resolve it.
      if (binding instanceof TmplAstVariable) {
        return scope.resolve(binding);
      } else if (binding instanceof TmplAstReference) {
        const target = tcb.boundTarget.getReferenceTarget(binding);
        if (target === null) {
          throw new Error(`Unbound reference? ${binding.name}`);
        }

        // The reference is either to an element, an <ng-template> node, or to a directive on an
        // element or template.

        if (target instanceof TmplAstElement) {
          return scope.resolve(target);
        } else if (target instanceof TmplAstTemplate) {
          // Direct references to an <ng-template> node simply require a value of type
          // `TemplateRef<any>`. To get this, an expression of the form
          // `(null as any as TemplateRef<any>)` is constructed.
          let value: ts.Expression = ts.createNull();
          value = ts.createAsExpression(value, ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword));
          value = ts.createAsExpression(value, tcb.referenceCoreType('TemplateRef', 1));
          value = ts.createParen(value);
          return value;
        } else {
          return scope.resolve(target.node, target.directive);
        }
      } else {
        throw new Error(`Unreachable: ${binding}`);
      }
    } else {
      // This is a PropertyRead(ImplicitReceiver) and probably refers to a property access on the
      // component context. Let it fall through resolution here so it will be caught when the
      // ImplicitReceiver is resolved in the branch below.
      return null;
    }
  } else if (ast instanceof ImplicitReceiver) {
    // AST instances representing variables and references look very similar to property reads from
    // the component context: both have the shape PropertyRead(ImplicitReceiver, 'propertyName').
    //
    // `tcbExpression` will first try to `tcbResolve` the outer PropertyRead. If this works, it's
    // because the `BoundTarget` found an expression target for the whole expression, and therefore
    // `tcbExpression` will never attempt to `tcbResolve` the ImplicitReceiver of that PropertyRead.
    //
    // Therefore if `tcbResolve` is called on an `ImplicitReceiver`, it's because no outer
    // PropertyRead resolved to a variable or reference, and therefore this is a property read on
    // the component context itself.
    return ts.createIdentifier('ctx');
  } else {
    // This AST isn't special after all.
    return null;
  }
}
