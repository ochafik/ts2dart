import * as base from './base';
import * as ts from 'typescript';
import {Transpiler} from './main';

type CallHandler = (c: ts.CallExpression, context: ts.Expression) => void;
type PropertyHandler = (c: ts.PropertyAccessExpression) => void;
type Set = {
  [s: string]: boolean
};

const FACADE_DEBUG = false;

const FACADE_NODE_MODULES_PREFIX = /^(\.\.\/)*node_modules\//;

function merge(...args: {[key: string]: any}[]): {[key: string]: any} {
  let returnObject: {[key: string]: any} = {};
  for (let arg of args) {
    for (let key of Object.getOwnPropertyNames(arg)) {
      returnObject[key] = arg[key];
    }
  }
  return returnObject;
}


export class FacadeConverter extends base.TranspilerBase {
  private tc: ts.TypeChecker;
  private candidateProperties: {[propertyName: string]: boolean} = {};
  private candidateTypes: {[typeName: string]: boolean} = {};
  private typingsRootRegex: RegExp;
  private genericMethodDeclDepth = 0;

  constructor(transpiler: Transpiler, typingsRoot = '') {
    super(transpiler);
    this.extractPropertyNames(this.callHandlers, this.candidateProperties);
    this.extractPropertyNames(this.propertyHandlers, this.candidateProperties);
    this.extractPropertyNames(this.TS_TO_DART_TYPENAMES, this.candidateTypes);

    this.typingsRootRegex = new RegExp('^' + typingsRoot.replace('.', '\\.'));
  }

  private extractPropertyNames(m: ts.Map<ts.Map<any>>, candidates: {[k: string]: boolean}) {
    for (let fileName of Object.keys(m)) {
      const file = m[fileName];
      Object.keys(file)
          .map((propName) => propName.substring(propName.lastIndexOf('.') + 1))
          .forEach((propName) => candidates[propName] = true);
    }
  }

  setTypeChecker(tc: ts.TypeChecker) { this.tc = tc; }

  maybeHandleCall(c: ts.CallExpression): boolean {
    if (!this.tc) return false;
    let {context, symbol} = this.getCallInformation(c);
    if (!symbol) {
      // getCallInformation returns a symbol if we understand this call.
      return false;
    }
    let handler = this.getHandler(c, symbol, this.callHandlers);
    return handler && !handler(c, context);
  }

  handlePropertyAccess(pa: ts.PropertyAccessExpression): boolean {
    if (!this.tc) return;
    let ident = pa.name.text;
    if (!this.candidateProperties.hasOwnProperty(ident)) return false;
    let symbol = this.tc.getSymbolAtLocation(pa.name);
    if (!symbol) {
      this.reportMissingType(pa, ident);
      return false;
    }

    let handler = this.getHandler(pa, symbol, this.propertyHandlers);
    return handler && !handler(pa);
  }

  /**
   * Searches for type references that require extra imports and emits the imports as necessary.
   */
  emitExtraImports(sourceFile: ts.SourceFile) {
    let libraries = <ts.Map<string>>{
      'XMLHttpRequest': 'dart:html',
      'KeyboardEvent': 'dart:html',
      'Uint8Array': 'dart:typed_arrays',
      'ArrayBuffer': 'dart:typed_arrays',
      'Promise': 'dart:async',
    };
    let emitted: Set = {};
    this.emitImports(sourceFile, libraries, emitted, sourceFile);
  }

  private emitImports(
      n: ts.Node, libraries: ts.Map<string>, emitted: Set, sourceFile: ts.SourceFile): void {
    if (n.kind === ts.SyntaxKind.TypeReference) {
      let type = base.ident((<ts.TypeReferenceNode>n).typeName);
      if (libraries.hasOwnProperty(type)) {
        let toEmit = libraries[type];
        if (!emitted[toEmit]) {
          this.emit(`import "${toEmit}";`);
          emitted[toEmit] = true;
        }
      }
    }

    n.getChildren(sourceFile)
        .forEach((child: ts.Node) => this.emitImports(child, libraries, emitted, sourceFile));
  }

  pushTypeParameterNames(n: ts.FunctionLikeDeclaration) {
    if (!n.typeParameters) return;
    this.genericMethodDeclDepth++;
  }

  popTypeParameterNames(n: ts.FunctionLikeDeclaration) {
    if (!n.typeParameters) return;
    this.genericMethodDeclDepth--;
  }

  resolvePropertyTypes(tn: ts.TypeNode): ts.Map<ts.PropertyDeclaration|ts.PropertySignature> {
    let res: ts.Map<ts.PropertyDeclaration|ts.PropertySignature> = {};
    if (tn && tn.kind === ts.SyntaxKind.TypeLiteral) {
      for (let m of (<ts.TypeLiteralNode>tn).members) {
        if (m.kind === ts.SyntaxKind.PropertySignature) {
          res[m.name.getText()] = <ts.PropertySignature>m;
        }
      }
    }
    if (!tn || !this.tc) return res;

    let t = this.tc.getTypeAtLocation(tn);
    for (let sym of this.tc.getPropertiesOfType(t)) {
      let decl = sym.valueDeclaration || (sym.declarations && sym.declarations[0]);
      if (decl.kind !== ts.SyntaxKind.PropertyDeclaration &&
          decl.kind !== ts.SyntaxKind.PropertySignature) {
        let msg = this.tc.getFullyQualifiedName(sym) +
            ' used for named parameter definition must be a property';
        this.reportError(decl, msg);
        continue;
      }
      res[sym.name] = <ts.PropertyDeclaration>decl;
    }
    return res;
  }

  /**
   * The Dart Development Compiler (DDC) has a syntax extension that uses comments to emulate
   * generic methods in Dart. ts2dart has to hack around this and keep track of which type names
   * in the current scope are actually DDC type parameters and need to be emitted in comments.
   *
   * TODO(martinprobst): Remove this once the DDC hack has made it into Dart proper.
   */
  private isGenericMethodTypeParameterName(name: ts.EntityName): boolean {
    // Avoid checking this unless needed.
    if (this.genericMethodDeclDepth === 0 || !this.tc) return false;
    // Check if the type of the name is a TypeParameter.
    let t = this.tc.getTypeAtLocation(name);
    if (!t || (t.flags & ts.TypeFlags.TypeParameter) === 0) return false;

    // Check if the symbol we're looking at is the type parameter.
    let symbol = this.tc.getSymbolAtLocation(name);
    if (symbol !== t.symbol) return false;

    // Check that the Type Parameter has been declared by a function declaration.
    return symbol.declarations.some(d => d.parent.kind === ts.SyntaxKind.FunctionDeclaration);
  }

  visitTypeName(typeName: ts.EntityName) {
    if (typeName.kind !== ts.SyntaxKind.Identifier) {
      this.visit(typeName);
      return;
    }
    let ident = base.ident(typeName);
    if (this.isGenericMethodTypeParameterName(typeName)) {
      // DDC generic methods hack - all names that are type parameters to generic methods have to be
      // emitted in comments.
      this.emit('dynamic/*=');
      this.emit(ident);
      this.emit('*/');
      return;
    }

    if (this.candidateTypes.hasOwnProperty(ident) && this.tc) {
      let symbol = this.tc.getSymbolAtLocation(typeName);
      if (!symbol) {
        this.reportMissingType(typeName, ident);
        return;
      }
      let fileAndName = this.getFileAndName(typeName, symbol);
      if (fileAndName) {
        let fileSubs = this.TS_TO_DART_TYPENAMES[fileAndName.fileName];
        if (fileSubs && fileSubs.hasOwnProperty(fileAndName.qname)) {
          this.emit(fileSubs[fileAndName.qname]);
          return;
        }
      }
    }
    this.emit(ident);
  }

  shouldEmitNew(c: ts.CallExpression): boolean {
    if (!this.tc) return true;

    let ci = this.getCallInformation(c);
    let symbol = ci.symbol;
    // getCallInformation returns a symbol if we understand this call.
    if (!symbol) return true;

    let loc = this.getFileAndName(c, symbol);
    if (!loc) return true;
    let {fileName, qname} = loc;
    let fileSubs = this.callHandlerReplaceNew[fileName];
    if (!fileSubs) return true;
    return !fileSubs[qname];
  }

  private getCallInformation(c: ts.CallExpression): {context?: ts.Expression, symbol?: ts.Symbol} {
    let symbol: ts.Symbol;
    let context: ts.Expression;
    let ident: string;
    let expr = c.expression;

    if (expr.kind === ts.SyntaxKind.Identifier) {
      // Function call.
      ident = base.ident(expr);
      if (!this.candidateProperties.hasOwnProperty(ident)) return {};
      symbol = this.tc.getSymbolAtLocation(expr);
      if (FACADE_DEBUG) console.error('s:', symbol);

      if (!symbol) {
        this.reportMissingType(c, ident);
        return {};
      }

      context = null;
    } else if (expr.kind === ts.SyntaxKind.PropertyAccessExpression) {
      // Method call.
      let pa = <ts.PropertyAccessExpression>expr;
      ident = base.ident(pa.name);
      if (!this.candidateProperties.hasOwnProperty(ident)) return {};

      symbol = this.tc.getSymbolAtLocation(pa);
      if (FACADE_DEBUG) console.error('s:', symbol);

      // Error will be reported by PropertyAccess handling below.
      if (!symbol) return {};

      context = pa.expression;
    }
    return {context, symbol};
  }

  private getHandler<T>(n: ts.Node, symbol: ts.Symbol, m: ts.Map<ts.Map<T>>): T {
    let loc = this.getFileAndName(n, symbol);
    if (!loc) return null;
    let {fileName, qname} = loc;
    let fileSubs = m[fileName];
    if (!fileSubs) return null;
    return fileSubs[qname];
  }

  private getFileAndName(n: ts.Node, originalSymbol: ts.Symbol): {fileName: string, qname: string} {
    let symbol = originalSymbol;
    while (symbol.flags & ts.SymbolFlags.Alias) symbol = this.tc.getAliasedSymbol(symbol);
    let decl = symbol.valueDeclaration;
    if (!decl) {
      // In the case of a pure declaration with no assignment, there is no value declared.
      // Just grab the first declaration, hoping it is declared once.
      if (!symbol.declarations || symbol.declarations.length === 0) {
        this.reportError(n, 'no declarations for symbol ' + originalSymbol.name);
        return null;
      }
      decl = symbol.declarations[0];
    }

    const fileName = decl.getSourceFile().fileName;
    const canonicalFileName = this.getRelativeFileName(fileName)
                                  .replace(/(\.d)?\.ts$/, '')
                                  .replace(FACADE_NODE_MODULES_PREFIX, '')
                                  .replace(this.typingsRootRegex, '');

    let qname = this.tc.getFullyQualifiedName(symbol);
    // Some Qualified Names include their file name. Might be a bug in TypeScript,
    // for the time being just special case.
    if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) {
      qname = symbol.getName();
    }
    if (FACADE_DEBUG) console.error('fn:', fileName, 'cfn:', canonicalFileName, 'qn:', qname);
    return {fileName: canonicalFileName, qname};
  }

  private isNamedType(node: ts.Node, fileName: string, qname: string): boolean {
    let symbol = this.tc.getTypeAtLocation(node).getSymbol();
    if (!symbol) return false;
    let actual = this.getFileAndName(node, symbol);
    if (fileName === 'lib' && !(actual.fileName === 'lib' || actual.fileName === 'lib.es6')) {
      return false;
    } else {
      if (fileName !== actual.fileName) return false;
    }
    return qname === actual.qname;
  }

  private reportMissingType(n: ts.Node, ident: string) {
    this.reportError(
        n, `Untyped property access to "${ident}" which could be ` + `a special ts2dart builtin. ` +
            `Please add type declarations to disambiguate.`);
  }

  isInsideConstExpr(node: ts.Node): boolean {
    return this.isConstCall(
        <ts.CallExpression>this.getAncestor(node, ts.SyntaxKind.CallExpression));
  }

  isConstCall(node: ts.Expression): boolean {
    return node && node.kind === ts.SyntaxKind.CallExpression &&
        base.ident((<ts.CallExpression>node).expression) === 'CONST_EXPR';
  }

  private emitMethodCall(name: string, args?: ts.Expression[]) {
    this.emit('.');
    this.emitCall(name, args);
  }

  private emitCall(name: string, args?: ts.Expression[]) {
    this.emit(name);
    this.emit('(');
    if (args) this.visitList(args);
    this.emit(')');
  }

  private stdlibTypeReplacements: ts.Map<string> = {
    'Date': 'DateTime',
    'Array': 'List',
    'XMLHttpRequest': 'HttpRequest',
    'Uint8Array': 'Uint8List',
    'ArrayBuffer': 'ByteBuffer',
    'Promise': 'Future',

    // Dart has two different incompatible DOM APIs
    // https://github.com/angular/angular/issues/2770
    'Node': 'dynamic',
    'Text': 'dynamic',
    'Element': 'dynamic',
    'Event': 'dynamic',
    'HTMLElement': 'dynamic',
    'HTMLAnchorElement': 'dynamic',
    'HTMLStyleElement': 'dynamic',
    'HTMLInputElement': 'dynamic',
    'HTMLDocument': 'dynamic',
    'History': 'dynamic',
    'Location': 'dynamic',
  };

  private TS_TO_DART_TYPENAMES: ts.Map<ts.Map<string>> = {
    'lib': this.stdlibTypeReplacements,
    'lib.es6': this.stdlibTypeReplacements,
    'angular2/src/facade/lang': {'Date': 'DateTime'},

    'rxjs/Observable': {'Observable': 'Stream'},
    'es6-promise/es6-promise': {'Promise': 'Future'},
    'es6-shim/es6-shim': {'Promise': 'Future'},
  };

  private es6Promises: ts.Map<CallHandler> = {
    'Promise.catch': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emit('.catchError(');
      this.visitList(c.arguments);
      this.emit(')');
    },
    'Promise.then': (c: ts.CallExpression, context: ts.Expression) => {
      // then() in Dart doesn't support 2 arguments.
      this.visit(context);
      this.emit('.then(');
      this.visit(c.arguments[0]);
      this.emit(')');
      if (c.arguments.length > 1) {
        this.emit('.catchError(');
        this.visit(c.arguments[1]);
        this.emit(')');
      }
    },
    'Promise': (c: ts.CallExpression, context: ts.Expression) => {
      if (c.kind !== ts.SyntaxKind.NewExpression) return true;
      this.assert(c, c.arguments.length === 1, 'Promise construction must take 2 arguments.');
      this.assert(
          c, c.arguments[0].kind === ts.SyntaxKind.ArrowFunction ||
              c.arguments[0].kind === ts.SyntaxKind.FunctionExpression,
          'Promise argument must be a function expression (or arrow function).');
      let callback: ts.FunctionLikeDeclaration;
      if (c.arguments[0].kind === ts.SyntaxKind.ArrowFunction) {
        callback = <ts.FunctionLikeDeclaration>(<ts.ArrowFunction>c.arguments[0]);
      } else if (c.arguments[0].kind === ts.SyntaxKind.FunctionExpression) {
        callback = <ts.FunctionLikeDeclaration>(<ts.FunctionExpression>c.arguments[0]);
      }
      this.assert(
          c, callback.parameters.length > 0 && callback.parameters.length < 3,
          'Promise executor must take 1 or 2 arguments (resolve and reject).');

      const completerVarName = this.uniqueId('completer');
      this.assert(
          c, callback.parameters[0].name.kind === ts.SyntaxKind.Identifier,
          'First argument of the Promise executor is not a straight parameter.');
      let resolveParameterIdent = <ts.Identifier>(callback.parameters[0].name);

      this.emit('(() {');  // Create a new scope.
      this.emit(`Completer ${completerVarName} = new Completer();`);
      this.emit('var');
      this.emit(resolveParameterIdent.text);
      this.emit(`= ${completerVarName}.complete;`);

      if (callback.parameters.length === 2) {
        this.assert(
            c, callback.parameters[1].name.kind === ts.SyntaxKind.Identifier,
            'First argument of the Promise executor is not a straight parameter.');
        let rejectParameterIdent = <ts.Identifier>(callback.parameters[1].name);
        this.emit('var');
        this.emit(rejectParameterIdent.text);
        this.emit(`= ${completerVarName}.completeError;`);
      }
      this.emit('(()');
      this.visit(callback.body);
      this.emit(')();');
      this.emit(`return ${completerVarName}.future;`);
      this.emit('})()');
    },
  };

  private stdlibHandlers: ts.Map<CallHandler> = merge(this.es6Promises, {
    'Array.push': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('add', c.arguments);
    },
    'Array.pop': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('removeLast');
    },
    'Array.shift': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emit('. removeAt ( 0 )');
    },
    'Array.unshift': (c: ts.CallExpression, context: ts.Expression) => {
      this.emit('(');
      this.visit(context);
      if (c.arguments.length === 1) {
        this.emit('.. insert ( 0,');
        this.visit(c.arguments[0]);
        this.emit(') ) . length');
      } else {
        this.emit('.. insertAll ( 0, [');
        this.visitList(c.arguments);
        this.emit(']) ) . length');
      }
    },
    'Array.map': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('map', c.arguments);
      this.emitMethodCall('toList');
    },
    'Array.filter': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('where', c.arguments);
      this.emitMethodCall('toList');
    },
    'Array.some': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('any', c.arguments);
    },
    'Array.slice': (c: ts.CallExpression, context: ts.Expression) => {
      this.emitCall('ListWrapper.slice', [context, ...c.arguments]);
    },
    'Array.splice': (c: ts.CallExpression, context: ts.Expression) => {
      this.emitCall('ListWrapper.splice', [context, ...c.arguments]);
    },
    'Array.concat': (c: ts.CallExpression, context: ts.Expression) => {
      this.emit('( new List . from (');
      this.visit(context);
      this.emit(')');
      c.arguments.forEach(arg => {
        if (!this.isNamedType(arg, 'lib', 'Array')) {
          this.reportError(arg, 'Array.concat only takes Array arguments');
        }
        this.emit('.. addAll (');
        this.visit(arg);
        this.emit(')');
      });
      this.emit(')');
    },
    'Array.join': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      if (c.arguments.length) {
        this.emitMethodCall('join', c.arguments);
      } else {
        this.emit('. join ( "," )');
      }
    },
    'Array.reduce': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);

      if (c.arguments.length >= 2) {
        this.emitMethodCall('fold', [c.arguments[1], c.arguments[0]]);
      } else {
        this.emit('. fold ( null ,');
        this.visit(c.arguments[0]);
        this.emit(')');
      }
    },
    'ArrayConstructor.isArray': (c: ts.CallExpression, context: ts.Expression) => {
      this.emit('( (');
      this.visitList(c.arguments);  // Should only be 1.
      this.emit(')');
      this.emit('is List');
      this.emit(')');
    },
    'RegExp.test': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('hasMatch', c.arguments);
    },
    'RegExp.exec': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('allMatches', c.arguments);
      this.emitMethodCall('toList');
    },
    'String.substr': (c: ts.CallExpression, context: ts.Expression) => {
      this.reportError(
          c, 'substr is unsupported, use substring (but beware of the different semantics!)');
      this.visit(context);
      this.emitMethodCall('substr', c.arguments);
    },
  });

  private es6Collections: ts.Map<CallHandler> = {
    'Map.set': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emit('[');
      this.visit(c.arguments[0]);
      this.emit(']');
      this.emit('=');
      this.visit(c.arguments[1]);
    },
    'Map.get': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emit('[');
      this.visit(c.arguments[0]);
      this.emit(']');
    },
    'Map.has': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emitMethodCall('containsKey', c.arguments);
    },
    'Map.delete': (c: ts.CallExpression, context: ts.Expression) => {
      // JS Map.delete(k) returns whether k was present in the map,
      // convert to:
      // (Map.containsKey(k) && (Map.remove(k) !== null || true))
      // (Map.remove(k) !== null || true) is required to always returns true
      // when Map.containsKey(k)
      this.emit('(');
      this.visit(context);
      this.emitMethodCall('containsKey', c.arguments);
      this.emit('&& (');
      this.visit(context);
      this.emitMethodCall('remove', c.arguments);
      this.emit('!= null || true ) )');
    },
    'Map.forEach': (c: ts.CallExpression, context: ts.Expression) => {
      let cb: any;
      let params: any;

      switch (c.arguments[0].kind) {
        case ts.SyntaxKind.FunctionExpression:
          cb = <ts.FunctionExpression>(c.arguments[0]);
          params = cb.parameters;
          if (params.length !== 2) {
            this.reportError(c, 'Map.forEach callback requires exactly two arguments');
            return;
          }
          this.visit(context);
          this.emit('. forEach ( (');
          this.visit(params[1]);
          this.emit(',');
          this.visit(params[0]);
          this.emit(')');
          this.visit(cb.body);
          this.emit(')');
          break;

        case ts.SyntaxKind.ArrowFunction:
          cb = <ts.ArrowFunction>(c.arguments[0]);
          params = cb.parameters;
          if (params.length !== 2) {
            this.reportError(c, 'Map.forEach callback requires exactly two arguments');
            return;
          }
          this.visit(context);
          this.emit('. forEach ( (');
          this.visit(params[1]);
          this.emit(',');
          this.visit(params[0]);
          this.emit(')');
          if (cb.body.kind !== ts.SyntaxKind.Block) {
            this.emit('=>');
          }
          this.visit(cb.body);
          this.emit(')');
          break;

        default:
          this.visit(context);
          this.emit('. forEach ( ( k , v ) => (');
          this.visit(c.arguments[0]);
          this.emit(') ( v , k ) )');
          break;
      }
    },
    'Array.find': (c: ts.CallExpression, context: ts.Expression) => {
      this.visit(context);
      this.emit('. firstWhere (');
      this.visit(c.arguments[0]);
      this.emit(', orElse : ( ) => null )');
    },
  };

  private callHandlerReplaceNew: ts.Map<ts.Map<boolean>> = {
    'es6-promise/es6-promise': {'Promise': true},
    'es6-shim/es6-shim': {'Promise': true},
  };

  private callHandlers: ts.Map<ts.Map<CallHandler>> = {
    'lib': this.stdlibHandlers,
    'lib.es6': this.stdlibHandlers,
    'es6-promise/es6-promise': this.es6Promises,
    'es6-shim/es6-shim': merge(this.es6Promises, this.es6Collections),
    'es6-collections/es6-collections': this.es6Collections,
    'angular2/manual_typings/globals': this.es6Collections,
    'angular2/src/facade/collection': {
      'Map': (c: ts.CallExpression, context: ts.Expression): boolean => {
        // The actual Map constructor is special cased for const calls.
        if (!this.isInsideConstExpr(c)) return true;
        if (c.arguments.length) {
          this.reportError(c, 'Arguments on a Map constructor in a const are unsupported');
        }
        if (c.typeArguments) {
          this.emit('<');
          this.visitList(c.typeArguments);
          this.emit('>');
        }
        this.emit('{ }');
        return false;
      },
    },
    'angular2/src/core/di/forward_ref': {
      'forwardRef': (c: ts.CallExpression, context: ts.Expression) => {
        // The special function forwardRef translates to an unwrapped value in Dart.
        const callback = <ts.FunctionExpression>c.arguments[0];
        if (callback.kind !== ts.SyntaxKind.ArrowFunction) {
          this.reportError(c, 'forwardRef takes only arrow functions');
          return;
        }
        this.visit(callback.body);
      },
    },
    'angular2/src/facade/lang': {
      'CONST_EXPR': (c: ts.CallExpression, context: ts.Expression) => {
        // `const` keyword is emitted in the array literal handling, as it needs to be transitive.
        this.visitList(c.arguments);
      },
      'normalizeBlank': (c: ts.CallExpression, context: ts.Expression) => {
        // normalizeBlank is a noop in Dart, so erase it.
        this.visitList(c.arguments);
      },
    },
  };

  private es6CollectionsProp: ts.Map<PropertyHandler> = {
    'Map.size': (p: ts.PropertyAccessExpression) => {
      this.visit(p.expression);
      this.emit('.');
      this.emit('length');
    },
  };
  private es6PromisesProp: ts.Map<PropertyHandler> = {
    'resolve': (p: ts.PropertyAccessExpression) => {
      this.visit(p.expression);
      this.emit('.value');
    },
    'reject': (p: ts.PropertyAccessExpression) => {
      this.visit(p.expression);
      this.emit('.error');
    },
  };

  private propertyHandlers: ts.Map<ts.Map<PropertyHandler>> = {
    'es6-shim/es6-shim': this.es6CollectionsProp,
    'es6-collections/es6-collections': this.es6CollectionsProp,
    'es6-promise/es6-promise': this.es6PromisesProp,
  };
}
