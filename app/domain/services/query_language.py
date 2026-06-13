"""Compact text query language for QueryAST.

Provides a small, safe, injection-free DSL that compiles to QueryAST.
The parser never interpolates values into SQL; it builds AST nodes that are
validated and compiled by the existing QueryAST pipeline.

Supported syntax examples:
    class:Task
    content:"hello world"
    ref:{current_node_uuid}
    create_date > {today}
    flag:is_page
    (class:A OR class:B) AND content:foo
    NOT parent:{current_node_uuid}
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from ..entities.query_ast import (
    ChildCondition,
    ClassCondition,
    ConditionNode,
    ContentCondition,
    ContentOperator,
    ExtendsCondition,
    FlagCondition,
    GroupNode,
    LogicType,
    NotNode,
    PageCondition,
    ParentCondition,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ReferenceCondition,
)

# Tokens produced by the lexer
TokenType = Literal[
    "WORD",
    "STRING",
    "NUMBER",
    "PLACEHOLDER",
    "OP",
    "LPAREN",
    "RPAREN",
    "AND",
    "OR",
    "NOT",
    "EOF",
]


@dataclass
class Token:
    """A single token from the query language input."""

    type: TokenType
    value: Any
    position: int = 0


class QueryLanguageError(ValueError):
    """Raised when a query cannot be parsed."""

    def __init__(self, message: str, position: int | None = None):
        super().__init__(message)
        self.position = position


class QueryLanguageTokenizer:
    """Tokenizes raw query text into a stream of Tokens."""

    OPERATORS = {":", "=", "!=", ">=", "<=", ">", "<"}

    def __init__(self, text: str):
        self.text = text
        self.pos = 0
        self.length = len(text)

    def tokenize(self) -> list[Token]:
        """Convert the entire input to a list of tokens."""
        tokens: list[Token] = []
        while self.pos < self.length:
            char = self.text[self.pos]

            if char.isspace():
                self.pos += 1
                continue

            if char == "(":
                tokens.append(Token("LPAREN", "(", self.pos))
                self.pos += 1
                continue

            if char == ")":
                tokens.append(Token("RPAREN", ")", self.pos))
                self.pos += 1
                continue

            if char in {'"', "'"}:
                tokens.append(self._read_string(char))
                continue

            if char == "{":
                tokens.append(self._read_placeholder())
                continue

            if char.isdigit() or (char == "-" and self._peek_is_digit()):
                tokens.append(self._read_number())
                continue

            if char.isalpha() or char == "_":
                tokens.append(self._read_word_or_keyword())
                continue

            op = self._read_operator()
            if op:
                tokens.append(Token("OP", op, self.pos))
                continue

            raise QueryLanguageError(
                f"Unexpected character {char!r} at position {self.pos}", self.pos
            )

        tokens.append(Token("EOF", None, self.pos))
        return tokens

    def _peek_is_digit(self) -> bool:
        next_pos = self.pos + 1
        return next_pos < self.length and self.text[next_pos].isdigit()

    def _read_string(self, quote: str) -> Token:
        start = self.pos
        self.pos += 1  # consume opening quote
        value_chars: list[str] = []
        while self.pos < self.length:
            char = self.text[self.pos]
            if char == quote:
                self.pos += 1
                return Token("STRING", "".join(value_chars), start)
            if char == "\\" and self.pos + 1 < self.length:
                value_chars.append(self.text[self.pos + 1])
                self.pos += 2
                continue
            value_chars.append(char)
            self.pos += 1
        raise QueryLanguageError("Unterminated string literal", start)

    def _read_placeholder(self) -> Token:
        start = self.pos
        self.pos += 1  # consume {
        value_chars: list[str] = []
        while self.pos < self.length and self.text[self.pos] != "}":
            value_chars.append(self.text[self.pos])
            self.pos += 1
        if self.pos >= self.length:
            raise QueryLanguageError("Unterminated placeholder", start)
        self.pos += 1  # consume }
        return Token("PLACEHOLDER", "{" + "".join(value_chars) + "}", start)

    def _read_number(self) -> Token:
        start = self.pos
        value_chars: list[str] = []
        has_dot = False
        while self.pos < self.length:
            char = self.text[self.pos]
            if char.isdigit():
                value_chars.append(char)
            elif char == "." and not has_dot:
                has_dot = True
                value_chars.append(char)
            elif char == "-" and self.pos == start:
                value_chars.append(char)
            else:
                break
            self.pos += 1
        raw = "".join(value_chars)
        value: int | float = float(raw) if has_dot else int(raw)
        return Token("NUMBER", value, start)

    def _read_word_or_keyword(self) -> Token:
        start = self.pos
        value_chars: list[str] = []
        while self.pos < self.length:
            char = self.text[self.pos]
            if char.isalnum() or char in {"_", "-", "."}:
                value_chars.append(char)
            else:
                break
            self.pos += 1
        raw = "".join(value_chars)
        upper = raw.upper()
        if upper == "AND":
            return Token("AND", "AND", start)
        if upper == "OR":
            return Token("OR", "OR", start)
        if upper == "NOT":
            return Token("NOT", "NOT", start)
        return Token("WORD", raw, start)

    def _read_operator(self) -> str | None:
        for op in ("!=", ">=", "<=", ":", "=", ">", "<"):
            end = self.pos + len(op)
            if self.text[self.pos:end] == op:
                self.pos = end
                return op
        return None


class QueryLanguageParser:
    """Recursive-descent parser for the query language."""

    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.pos = 0

    def parse(self) -> QueryAST:
        """Parse the token stream into a QueryAST."""
        if self._current().type == "EOF":
            return QueryAST()
        root = self._parse_expression()
        if self._current().type != "EOF":
            token = self._current()
            raise QueryLanguageError(
                f"Unexpected token {token.value!r} at position {token.position}",
                token.position,
            )
        return QueryAST(root_group=self._ensure_group(root))

    def _current(self) -> Token:
        return self.tokens[self.pos]

    def _advance(self) -> Token:
        token = self._current()
        if self.pos < len(self.tokens) - 1:
            self.pos += 1
        return token

    def _expect(self, token_type: TokenType) -> Token:
        token = self._current()
        if token.type != token_type:
            raise QueryLanguageError(
                f"Expected {token_type} but got {token.value!r} at position {token.position}",
                token.position,
            )
        return self._advance()

    def _parse_expression(self) -> GroupNode | ConditionNode | NotNode:
        return self._parse_or()

    def _parse_or(self) -> GroupNode | ConditionNode | NotNode:
        left = self._parse_and()
        while self._current().type == "OR":
            self._advance()
            right = self._parse_and()
            if isinstance(left, GroupNode) and left.logic == LogicType.OR:
                left.children.append(right)
            else:
                left = GroupNode(logic=LogicType.OR, children=[left, right])
        return left

    def _parse_and(self) -> GroupNode | ConditionNode | NotNode:
        left = self._parse_not()
        while self._is_implicit_and_start():
            if self._current().type == "AND":
                self._advance()
            right = self._parse_not()
            if isinstance(left, GroupNode) and left.logic == LogicType.AND:
                left.children.append(right)
            else:
                left = GroupNode(logic=LogicType.AND, children=[left, right])
        return left

    def _is_implicit_and_start(self) -> bool:
        """Return True if the current token can start another AND operand."""
        return self._current().type in {
            "AND",
            "NOT",
            "WORD",
            "LPAREN",
            "STRING",
            "NUMBER",
            "PLACEHOLDER",
        }

    def _parse_not(self) -> GroupNode | ConditionNode | NotNode:
        if self._current().type == "NOT":
            self._advance()
            child = self._parse_primary()
            return NotNode(child=child)
        return self._parse_primary()

    def _parse_primary(self) -> GroupNode | ConditionNode | NotNode:
        if self._current().type == "LPAREN":
            self._advance()
            inner = self._parse_expression()
            self._expect("RPAREN")
            return inner
        return self._parse_field_condition()

    def _parse_field_condition(self) -> ConditionNode:
        token = self._expect("WORD")
        field = token.value

        op_token = self._current()
        if op_token.type == "OP":
            self._advance()
            op = op_token.value
        else:
            # Default to colon when omitted (e.g. "class Task")
            op = ":"

        value_token = self._parse_value()
        value = value_token.value
        return self._build_condition(field, op, value)

    def _parse_value(self) -> Token:
        token = self._current()
        if token.type in {"STRING", "PLACEHOLDER", "NUMBER", "WORD"}:
            self._advance()
            return token
        raise QueryLanguageError(
            f"Expected value but got {token.value!r} at position {token.position}",
            token.position,
        )

    def _build_condition(self, field: str, op: str, value: Any) -> ConditionNode:
        field_lower = field.lower()

        if field_lower == "class":
            return ClassCondition(
                class_uuid=str(value),
                operator=self._map_class_operator(op),
            )

        if field_lower == "extends":
            return ExtendsCondition(extends_class_uuid=str(value))

        if field_lower == "content":
            return ContentCondition(
                operator=self._map_content_operator(op),
                value=str(value),
            )

        if field_lower == "ref":
            return ReferenceCondition(
                target_uuid=str(value),
                operator=self._map_reference_operator(op),
            )

        if field_lower == "parent":
            return ParentCondition(
                parent_uuid=str(value),
                operator=self._map_parent_operator(op),
            )

        if field_lower == "child":
            return ChildCondition(
                child_uuids=[str(value)],
                operator=self._map_child_operator(op),
            )

        if field_lower == "page":
            return PageCondition(
                page_uuid=str(value),
                operator=self._map_page_operator(op),
            )

        if field_lower == "flag":
            return FlagCondition(flag_name=str(value))

        return PropertyCondition(
            property_name=field,
            operator=self._map_property_operator(op),
            value=value,
            property_type=self._infer_property_type(value),
        )

    def _map_content_operator(self, op: str) -> ContentOperator:
        if op == ":":
            return ContentOperator.CONTAINS
        mapping = {
            "=": ContentOperator.EQUALS,
            "!=": ContentOperator.EQUALS,  # handled via NOT wrapping
            ">": ContentOperator.FTS,
            "<": ContentOperator.FTS,
            ">=": ContentOperator.FTS,
            "<=": ContentOperator.FTS,
        }
        return mapping.get(op, ContentOperator.CONTAINS)

    def _map_class_operator(self, op: str) -> str:
        if op == ":":
            return "contains"
        mapping = {
            "=": "is",
            "!=": "is_not",
        }
        return mapping.get(op, "contains")

    def _map_reference_operator(self, op: str) -> str:
        if op in (":", "="):
            return "references"
        if op == "!=":
            return "does_not_reference"
        return "references"

    def _map_parent_operator(self, op: str) -> str:
        if op in (":", "="):
            return "has_parent"
        if op == "!=":
            return "not_has_parent"
        return "has_parent"

    def _map_child_operator(self, op: str) -> str:
        if op in (":", "="):
            return "has_child"
        if op == "!=":
            return "not_has_child"
        return "has_child"

    def _map_page_operator(self, op: str) -> str:
        if op in (":", "="):
            return "is_page"
        if op == "!=":
            return "is_not_page"
        return "is_page"

    def _map_property_operator(self, op: str) -> PropertyOperator:
        if op == ":":
            return PropertyOperator.EQUALS
        mapping = {
            "=": PropertyOperator.EQUALS,
            "!=": PropertyOperator.NOT_EQUALS,
            ">": PropertyOperator.GREATER_THAN,
            "<": PropertyOperator.LESS_THAN,
            ">=": PropertyOperator.GREATER_THAN_OR_EQUALS,
            "<=": PropertyOperator.LESS_THAN_OR_EQUALS,
        }
        return mapping.get(op, PropertyOperator.EQUALS)

    def _infer_property_type(self, value: Any) -> PropertyType:
        if isinstance(value, str):
            if value.startswith("{"):
                if value in ("{today}", "{this_week}", "{this_month}", "{this_year}"):
                    return PropertyType.DATE
                if value in ("{current_node_uuid}", "{current_node_id}"):
                    return PropertyType.NODE
                return PropertyType.TEXT
            if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
                return PropertyType.DATE
        if isinstance(value, (int, float)):
            return PropertyType.NUMBER if isinstance(value, int) else PropertyType.FLOAT
        return PropertyType.TEXT

    def _ensure_group(
        self, node: GroupNode | ConditionNode | NotNode
    ) -> GroupNode:
        if isinstance(node, GroupNode):
            return node
        return GroupNode(logic=LogicType.AND, children=[node])


def parse_query_language(text: str) -> QueryAST:
    """Parse a query-language string into a QueryAST."""
    tokenizer = QueryLanguageTokenizer(text)
    tokens = tokenizer.tokenize()
    parser = QueryLanguageParser(tokens)
    return parser.parse()
