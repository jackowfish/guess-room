# guess-room

Multi-user number-guessing room. Make a room, share the code, everyone picks a number, host reveals the average.

## Run

```
docker build -t guess-room .
docker run --rm -p 3000:3000 guess-room
```

Open http://localhost:3000.

## Config

| env | default | what |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string. If unset or pointing at localhost, an in-container Redis is started; otherwise the bundled one stays off. |

## Deploy (HA)

Point `REDIS_URL` at a shared Redis (any non-localhost host) and run as many replicas as you like — Socket.IO uses the Redis adapter so rooms and events are shared across instances. Rooms expire after 24h of inactivity via TTL.

## Host settings

- show guesses by person on reveal
- drop highest and lowest before averaging
- format: number / dollars / euros / pounds / percent
