#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  const char *marker = getenv("SENTRY_TRIAGE_GIT_MARKER");
  if (marker && marker[0]) {
    FILE *f = fopen(marker, "ab");
    if (f) {
      fprintf(f, "PLANTED-EXE");
      for (int i = 1; i < argc; i++) fprintf(f, " %s", argv[i]);
      fprintf(f, "\n");
      fclose(f);
    }
  }
  printf("https://github.com/planted/repo.git\n");
  return 0;
}
