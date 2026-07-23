"""Server-Sent Events (SSE) stream parser for the Answer Engine API."""

import json
from typing import AsyncIterator


async def parse_sse_stream(body) -> AsyncIterator[dict]:
    """Parse an SSE byte stream into event dicts.

    Yields dicts with 'event' and 'data' keys.
    """
    buffer = b''
    current_event = ''
    current_data: list[str] = []

    async for chunk in body:
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            decoded = line.decode('utf-8')

            if decoded.startswith('event: '):
                current_event = decoded[7:].strip()
            elif decoded.startswith('data: '):
                current_data.append(decoded[6:])
            elif decoded == '':
                # Empty line signals end of an event
                if current_event and current_data:
                    raw = '\n'.join(current_data)
                    try:
                        parsed = json.loads(raw)
                        yield {'event': current_event, 'data': parsed}
                    except json.JSONDecodeError:
                        pass
                current_event = ''
                current_data = []

    # Flush remaining buffer
    if current_event and current_data:
        raw = '\n'.join(current_data)
        try:
            parsed = json.loads(raw)
            yield {'event': current_event, 'data': parsed}
        except json.JSONDecodeError:
            pass
