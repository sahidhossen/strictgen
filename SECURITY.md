# Security policy

## Supported versions

strictgen has no stable release yet. Once it does, security fixes go to the latest minor version.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/sahidhossen/strictgen/security/advisories/new) for this repository.

Include what you can of:

- The schema and payload that trigger it
- The strictgen version and the target language
- What happens, and what you expected

You'll get an acknowledgement within 7 days. Once a fix is ready we'll agree a disclosure date with you and credit you in the advisory unless you'd rather not be named.

## Scope

strictgen's job is to make generated decoders reject anything the schema doesn't allow. Reports where a generated decoder in any language accepts a payload the schema rejects, drops data silently, or disagrees with another language on a payload that matters for security (for example a signed or hashed payload) are in scope.
