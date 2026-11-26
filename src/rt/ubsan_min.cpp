// Reports integer overflow.
//
// The compiler adds overflow checks (see cpp-worker.js). When one fails, it calls one of the handlers
// below. Each handler prints a warning to stderr, up to three in total, and lets the program continue.
//
// The warnings matter because `long` is 64 bits on the judge but 32 bits here, so code that relies on a
// 64-bit `long` overflows here but not on the judge.
#include <cstdio>

static int reported = 0;

static void report(const char* problem) {
  if (reported < 3) {
    std::fprintf(stderr,
                 "[IDE] Integer overflow (%s). On the judge, long is 64 bits; here it is 32 bits. "
                 "Use long long.\n",
                 problem);
  }
  reported++;
}

// Defines the two handlers for one kind of problem. The compiler calls the first one; the second one is
// for builds that stop at the first problem.
#define HANDLER(name)                                    \
  extern "C" void __ubsan_handle_##name##_minimal() {    \
    report(#name);                                       \
  }                                                      \
  extern "C" void __ubsan_handle_##name##_minimal_abort() { \
    report(#name);                                       \
    __builtin_trap();                                    \
  }

HANDLER(add_overflow)
HANDLER(sub_overflow)
HANDLER(mul_overflow)
HANDLER(negate_overflow)
HANDLER(implicit_conversion)
HANDLER(divrem_overflow)
HANDLER(shift_out_of_bounds)
