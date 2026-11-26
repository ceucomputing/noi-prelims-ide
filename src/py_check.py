"""Find the parts of a program that Python 3.8, the judge's version, does not have."""

import ast
import re

import vermin


def check_python_38(source):
    """Return a list of messages, one per feature that needs a Python version newer than 3.8."""
    messages = []

    try:
        ast.parse(source, feature_version=(3, 8))
    except SyntaxError as error:
        messages.append(f"line {error.lineno}: not valid Python 3.8 syntax ({error.msg})")

    config = vermin.Config()
    config.set_verbose(3)
    config.set_eval_annotations(True)
    try:
        result = vermin.visit(source, config)
    except SyntaxError:
        return messages

    for line in result.output_text().splitlines():
        match = re.search(r"requires (?:!2, )?3\.(\d+)", line)
        if match and int(match.group(1)) > 8:
            messages.append(line.strip())
    return messages
