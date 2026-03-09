# LSP-First Code Intelligence

**Principle: LSP first, fallback to Grep/Read.** LSP operations return precise, scoped results in one call. Grep/Read scans files line by line, consuming far more tokens for the same information.

## When to Use LSP

| Need | LSP Operation | Fallback |
|---|---|---|
| What methods/fields does this class have? | `documentSymbol` | Read the file |
| Where is this symbol defined? | `goToDefinition` | Grep for `class X`, `def X`, `fun X` |
| What type is this variable/return value? | `hover` | Read surrounding code and infer |
| Where is this symbol used? | `findReferences` | Grep for the symbol name |
| What calls this function? | `incomingCalls` | Grep for the function name |
| What does this function call? | `outgoingCalls` | Read the function body |
| What implements this interface? | `goToImplementation` | Grep for `implements X`, `: X` |

## Fallback Rules

LSP availability depends on what language servers the user has installed. Don't assume — **detect at runtime**.

### Runtime Detection

On first code navigation in a session, probe with a quick `documentSymbol` on a relevant source file. If it returns results, LSP is available for that file type — use it for all subsequent operations. If it errors or returns nothing, that language has no LSP — use Grep/Read for the rest of the session. Cache the result mentally (don't re-probe the same file type).

### Fallback Behavior

1. **Try LSP first** — if it returns results, use it
2. **If LSP errors or returns nothing** — fall back to Grep/Read silently. Do not mention the failure to the user
3. **If an operation is unsupported** (e.g., "no handler for request") — use the workarounds below. The core operations (`documentSymbol`, `goToDefinition`, `hover`, `findReferences`) work on virtually all servers. Advanced operations (`goToImplementation`, call hierarchy) vary by server

## Workarounds for Unsupported Operations

Not all language servers support every operation. When an operation fails or returns "no handler," use these workarounds:

- **`goToImplementation` unsupported:** Use `findReferences` on the interface/abstract method, then filter results for non-interface files. Gets ~90% of the way there.
- **Call hierarchy unsupported (`incomingCalls`/`outgoingCalls`):** Use `findReferences` recursively — find references to a method, then find references to each caller.
- **Workspace-wide search:** `workspaceSymbol` is broken (bug #30948). Grep with the symbol name is fast and reliable.

## Token Savings

- `documentSymbol` on a 500-line file: ~20 tokens (symbol list) vs ~2000 tokens (reading the whole file)
- `findReferences`: ~10 tokens per reference vs grep output with surrounding context
- `goToDefinition`: 1 line vs searching across files
- `hover`: type info in ~5 tokens vs reading + inferring from code

## Operation Reliability

| Operation | Widely Supported? | If Unsupported |
|---|---|---|
| `documentSymbol` | ✅ Yes | Read the file |
| `goToDefinition` | ✅ Yes | Grep for the definition |
| `hover` | ✅ Yes | Read surrounding code |
| `findReferences` | ✅ Yes | Grep for the symbol name |
| `goToImplementation` | ⚠️ Varies | `findReferences` + filter non-interface files |
| `incomingCalls` | ⚠️ Varies | `findReferences` recursively |
| `outgoingCalls` | ⚠️ Varies | `findReferences` recursively |
| `workspaceSymbol` | ❌ Broken | Grep for the symbol name |

## Practical Patterns

**Understanding a file before modifying it:**
```
1. documentSymbol → get the structure (classes, methods, fields)
2. Only Read specific methods you need to change
```

**Tracing a bug:**
```
1. goToDefinition → find where the suspect symbol lives
2. incomingCalls → who calls it? (narrows the call chain)
3. outgoingCalls → what does it depend on?
4. findReferences → where else is this used? (impact radius)
```

**Assessing change impact:**
```
1. findReferences → all usages of the symbol being changed
2. goToImplementation → all concrete implementations of an interface
3. hover → check types at each usage site
```

**Code review:**
```
1. documentSymbol → get overview of changed file
2. findReferences → verify all usages covered by tests
3. hover → check types without reading imports
```
