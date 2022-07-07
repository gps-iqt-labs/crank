import {c, Element} from "./crank.js";
import type {Tag} from "./crank.js";

export const t = template;

export default template;

export function template(
	spans: TemplateStringsArray,
	...expressions: Array<unknown>
): Element {
	let parsed = parse(spans.raw, expressions);
	const children = parsed.children;
	if (children.length === 0) {
		return c("");
	} else if (children.length === 1 && children[0].type === "element") {
		parsed = children[0];
	}

	// TODO: cache the parse results
	return createElementsFromParse(parsed);
}

interface ParseElement {
	type: "element";
	tag: Tag;
	props: Record<string, any> | null;
	children: Array<ParseElement | ParseValue>;
}

interface ParseValue {
	type: "value";
	value: unknown;
}

/* Grammar
$CHILDREN: ($ELEMENT | $COMMENT | ${unknown} | [\S\s])*
// TODO: Maybe allow escaped angle brackets here.
$ELEMENT:
  $SELF_CLOSING_ELEMENT |
  $OPENING_ELEMENT $CHILDREN $CLOSING_ELEMENT
$SELF_CLOSING_ELEMENT: "<" ($IDENTIFIER | ${Tag}) $PROPS "/" ">"
$OPENING_ELEMENT: "<" ($IDENTIFIER | ${Tag})? $PROPS ">"
$CLOSING_ELEMENT: "<" "/" "/"? ($IDENTIFIER | ${Tag})? ">"
$PROPS: ($PROP | $SPREAD_PROP)*
// TODO: Maybe allow prop names to be expressions.
$PROP: $IDENTIFIER ("=" $PROP_VALUE)?
$SPREAD_PROP: "..." ${unknown}
$IDENTIFIER: [-_$\w]+
$PROP_VALUE:
  ('"' ('\\"' | [\S\s] | ${unknown})*? '"') |
  ("'" ("\\'" | [\S\s] | ${unknown})*? "'") |
  ${unknown}
$COMMENT: "<!--" ([\S\s] | ${unknown})*? "-->"
*/

/*
 * Matches first significant character in children mode.
 *
 * Group 1: newline
 * Group 2: comment
 * Group 3: tag
 * Group 4: closing slash
 * Group 5: tag name
 */
const CHILDREN_RE =
	/((?:\r|\n|\r\n)\s*)|(<!--[\S\s]*?(?:-->|$))|(<\s*(\/{0,2})\s*([-_$\w]*))/g;

/*
 * Matches props after element tags.
 *
 * Group 1: tag end
 * Group 2: spread props
 * Group 3: prop name
 * Group 4: equals
 * Group 5: prop value string
 */
const PROPS_RE =
	/\s*(?:(\/?\s*>)|(\.\.\.\s*)|(?:([-_$\w]+)\s*(=)?\s*(?:("(\\"|[\S\s])*?(?:"|$)|'(?:\\'|[\S\s])*?(?:'|$)))?))/g;

const CLOSING_TAG_RE = />/g;

const CLOSING_SINGLE_QUOTE_RE = /[^\\]?'/g;

const CLOSING_DOUBLE_QUOTE_RE = /[^\\]?"/g;

const CLOSING_COMMENT_RE = /-->/g;

function parse(
	spans: ArrayLike<string>,
	expressions: Array<unknown>,
): ParseElement {
	let current: ParseElement = {
		type: "element",
		tag: "",
		props: null,
		children: [],
	};
	const stack: Array<ParseElement> = [];
	let matcher = CHILDREN_RE as RegExp;
	let lineStart = true;
	// stringName and stringValue are used as state when handling expressions in
	// prop strings
	//   t`<p class="foo ${exp}" />`
	let propName = "";
	let propValue = "";
	for (let s = 0; s < spans.length; s++) {
		const span = spans[s];
		// Whether or not an expression is upcoming. Set to false when expressions
		// are consumed.
		let expressing = s < spans.length - 1;
		if (expressing && span === "") {
			// We have multiple expressions in a row.
			//   <p>${a}${b}</p>
			switch (matcher) {
				case CHILDREN_RE:
					current.children.push({type: "value", value: expressions[s]});
					expressing = false;
					break;
				case CLOSING_SINGLE_QUOTE_RE:
				case CLOSING_DOUBLE_QUOTE_RE:
					const exp = expressions[s];
					if (typeof exp !== "boolean" && exp != null) {
						propValue += typeof exp === "string" ? exp : String(exp);
					}

					expressing = false;
					break;
			}
		}

		for (let i = 0, end = i; i < span.length; i = end) {
			matcher.lastIndex = i;
			const match = matcher.exec(span);
			end = match ? match.index + match[0].length : span.length;
			switch (matcher) {
				case CHILDREN_RE:
					if (match) {
						const [, newline, comment, tag, slash, tagName] = match;
						if (i < match.index) {
							let before = span.slice(i, match.index);
							if (lineStart) {
								before = before.replace(/^\s*/, "");
							}

							if (newline) {
								// We preserve whitespace before escaped newlines.
								//   t` \
								//   `
								if (span[Math.max(0, match.index - 1)] === "\\") {
									// remove the backslash
									before = before.slice(0, -1);
								} else {
									before = before.replace(/\s*$/, "");
								}
							}
							if (before) {
								current.children.push({type: "value", value: before});
							}
						}

						lineStart = !!newline;
						if (comment) {
							if (end === span.length) {
								// We allow expressions in comments:
								//   t`<!-- ${exp} -->`
								matcher = CLOSING_COMMENT_RE;
								if (expressing && end === span.length) {
									expressing = false;
								}
							}
						} else if (tag) {
							let tag: Tag = tagName;
							if (expressing && end === span.length) {
								tag = expressions[s] as Tag;
								expressing = false;
							}

							if (slash) {
								if (!stack.length) {
									throw new SyntaxError(
										`Unmatched closing tag "${getTagDisplay(tag)}"`,
									);
								} else if (slash !== "//" && current.tag !== tag) {
									throw new SyntaxError(
										`Mismatched closing tag "${getTagDisplay(
											tag,
										)}" for opening tag "${getTagDisplay(current.tag)}"`,
									);
								}

								current = stack.pop()!;
								matcher = CLOSING_TAG_RE;
							} else {
								stack.push(current);
								const next = {
									type: "element" as const,
									tag,
									props: null,
									children: [],
								};
								current.children.push(next);
								current = next;
								matcher = PROPS_RE;
							}
						}
					} else {
						if (i < span.length) {
							let after = span.slice(i);
							if (!expressing) {
								after = after.replace(/\s*$/, "");
							}

							if (after) {
								current.children.push({type: "value", value: after});
							}
						}
					}

					if (expressing && end === span.length) {
						current.children.push({type: "value", value: expressions[s]});
						lineStart = false;
						expressing = false;
					}

					break;
				case PROPS_RE:
					if (match) {
						const [, tagEnd, spread, name, equals, string] = match;
						if (i < match.index) {
							throw new SyntaxError(
								`Unexpected text \`${span.slice(i, match.index).trim()}\``,
							);
						}

						if (tagEnd) {
							if (tagEnd[0] === "/") {
								// This is a self-closing element, so there will always be a
								// result on the stack.
								current = stack.pop()!;
							}

							matcher = CHILDREN_RE;
							if (expressing && end === span.length) {
								current.children.push({type: "value", value: expressions[s]});
								expressing = false;
							}
						} else if (spread) {
							if (!(expressing && end === span.length)) {
								throw new SyntaxError(
									`Missing expression after "..." while parsing props for ${String(
										getTagDisplay(current.tag),
									)}`,
								);
							}

							current.props = {...current.props, ...(expressions[s] as any)};
							expressing = false;
						} else if (name) {
							let value: unknown;
							if (string == null) {
								if (!equals) {
									value = true;
								} else if (end < span.length) {
									throw new SyntaxError(
										`Unexpected text \`${span.slice(end, end + 20)}\``,
									);
								} else if (!expressing) {
									throw new SyntaxError("Expression expected");
								} else {
									value = expressions[s];
									expressing = false;
								}
							} else {
								const quote = string[0];
								if (expressing && end === span.length) {
									propName = name;
									propValue = string;
									const exp = expressions[s];
									if (typeof exp !== "boolean" && exp != null) {
										propValue += typeof exp === "string" ? exp : String(exp);
									}

									matcher =
										quote === "'"
											? CLOSING_SINGLE_QUOTE_RE
											: CLOSING_DOUBLE_QUOTE_RE;
									expressing = false;
									break;
								}

								value = formatString(string);
							}

							current.props = {...current.props, ...{[name]: value}};
						}
					} else {
						// TODO: is this branch actually possible?
						if (!expressing) {
							// Not sure how much context to provide, 20 characters seems fine?
							throw new SyntaxError(
								`Unexpected text \`${span.slice(i, i + 20).trim()}\``,
							);
						}
					}
					break;
				case CLOSING_TAG_RE:
					if (match) {
						if (i < match.index) {
							throw new SyntaxError(
								`Unexpected text \`${span.slice(i, match.index).trim()}\``,
							);
						}
						matcher = CHILDREN_RE;
					} else {
						if (!expressing) {
							// Not sure how much context to provide, 20 characters seems fine?
							throw new SyntaxError(
								`Unexpected text \`${span.slice(i, i + 20).trim()}\``,
							);
						}
					}
					break;
				case CLOSING_SINGLE_QUOTE_RE:
				case CLOSING_DOUBLE_QUOTE_RE:
					if (match) {
						propValue += span.slice(i, end);
						matcher = PROPS_RE;
					} else {
						propValue += span.slice(i);
					}

					if (expressing && end === span.length) {
						const exp = expressions[s];
						// TODO: erase all oddballs and not just null/undefined
						if (exp != null) {
							propValue += typeof exp === "string" ? exp : String(exp);
						}

						expressing = false;
					}

					current.props = {...current.props, ...{[propName]: formatString(propValue)}};
					break;
				case CLOSING_COMMENT_RE:
					if (match) {
						matcher = CHILDREN_RE;
					} else {
						if (!expressing) {
							throw new SyntaxError('Missing "-->"');
						}

						expressing = false;
					}
					break;
			}
		}

		if (expressing) {
			const value = expressions[s];
			throw new SyntaxError(
				`Unexpected expression \${${JSON.stringify(value)}}`,
			);
		}
	}

	if (stack.length) {
		throw new SyntaxError(
			`Unmatched opening tag "${getTagDisplay(current.tag)}"`,
		);
	}

	return current;
}

function getTagDisplay(tag: Tag) {
	return typeof tag === "function"
		? tag.name
		: typeof tag !== "string"
		? String(tag)
		: tag;
}

function formatString(str: string) {
	return (
		str
			// remove quotes
			.slice(1, -1)
			// deal with escaped characters
			.replace(/\\(.?)/g, "$1")
	);
}

function createElementsFromParse(parsed: ParseElement): Element {
	const children: Array<unknown> = [];
	for (let i = 0; i < parsed.children.length; i++) {
		const child = parsed.children[i];
		children.push(
			child.type === "element" ? createElementsFromParse(child) : child.value,
		);
	}

	return c(parsed.tag, parsed.props, ...children);
}
