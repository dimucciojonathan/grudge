# Records the README GIF with https://github.com/charmbracelet/vhs
# Run from the repo root:
#   node demo/make-demo.js && vhs demo/demo.tape
# Uses fake history from demo/make-demo.js, never real transcripts.
Output "demo/grudge.gif"
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 680
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Hide
Type "export GRUDGE_HOME=/tmp/grudge-demo/home GRUDGE_CLAUDE_DIR=/tmp/grudge-demo/claude GRUDGE_CODEX_DIR=/tmp/grudge-demo/none"
Enter
Type "rm -rf /tmp/grudge-demo/home; npx() { node ./bin/grudge.js; }; clear"
Enter
Show

Sleep 500ms
Type "npx grudge-cc"
Sleep 600ms
Enter
Sleep 6s
