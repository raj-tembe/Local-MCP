# Tool reference

## Terminal

- `terminal.create` – create a shell PTY session
- `terminal.write` – send input to a PTY
- `terminal.read` – read PTY output
- `terminal.resize` – resize the PTY
- `terminal.kill` – kill a session
- `terminal.list` – enumerate PTY sessions
- `shell.execute` – execute a one-shot command

## User I/O

- `user.prompt` – wait for user input
- `user.notify` – display a desktop notification
- `user.clipboard.read` – read clipboard contents
- `user.clipboard.write` – write clipboard contents
- `user.open_url` – open a URL in the default browser
- `user.stdout.write` – write to stdout
- `user.stderr.write` – write to stderr

## Filesystem

- `fs.read` – read file contents
- `fs.write` – write file contents
- `fs.list` – list directory entries
- `fs.search` – search paths or file names
- `fs.stat` – retrieve metadata

## System

- `system.info` – basic system information

## Resources

- `terminal://sessions/{id}`
- `fs://cwd`
- `system://info`
