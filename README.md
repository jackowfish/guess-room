# guess-room

Multi-user number-guessing room. Make a room, share the code, everyone picks a number, host reveals the average.

## Run

```
docker build -t guess-room .
docker run --rm -p 3000:3000 guess-room
```

Open http://localhost:3000.

Redis runs in-process; rooms expire after 24h.

## Host settings

- show guesses by person on reveal
- drop highest and lowest before averaging
- format: number / dollars / euros / pounds / percent
