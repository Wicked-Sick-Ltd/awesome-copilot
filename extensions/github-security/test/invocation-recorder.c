#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
	const char *log_path = getenv("INVOCATION_LOG");
	if (log_path != NULL) {
		FILE *log = fopen(log_path, "a");
		if (log != NULL) {
			char cwd[4096];
			if (getcwd(cwd, sizeof cwd) == NULL) cwd[0] = '\0';
			fprintf(log, "ARGV0=%s\nCWD=%s\n", argv[0], cwd);
			for (int i = 0; i < argc; i++) fprintf(log, "ARG=%s\n", argv[i]);
			fputs("END\n", log);
			fclose(log);
		}
	}

	const char *base = argv[0];
	for (const char *cursor = argv[0]; *cursor != '\0'; cursor++) {
		if (*cursor == '/' || *cursor == '\\') base = cursor + 1;
	}
	if (strcmp(base, "ssh") == 0 || strcmp(base, "ssh.exe") == 0) {
		fputs("hostname github.com\n", stdout);
		return 0;
	}
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "get-url") == 0) {
			const char *url = getenv("GIT_REMOTE_URL");
			if (url != NULL) puts(url);
			return 0;
		}
	}
	return 0;
}
