// Fast cin and cout after std::ios_base::sync_with_stdio(false).
//
// With libstdc++, as on the judge, calling sync_with_stdio(false) switches cin and cout to large buffers.
// libc++, which the IDE uses, keeps reading and writing one character at a time, which is far slower.
//
// The linker replaces libc++'s sync_with_stdio with the function below (see the --wrap flag in
// cpp-worker.js). When a program turns synchronisation off, it gives cin and cout large buffers, as
// libstdc++ does. As with libstdc++, the program should then not mix C stdio with cin and cout.
#include <cstdio>
#include <iostream>
#include <streambuf>
#include <unistd.h>

namespace {

// Reads standard input in large blocks.
class InputBuffer : public std::streambuf {
 protected:
  int_type underflow() override {
    if (gptr() < egptr()) {
      return traits_type::to_int_type(*gptr());
    }
    ssize_t n = ::read(0, buffer_, sizeof buffer_);
    if (n <= 0) {
      return traits_type::eof();
    }
    setg(buffer_, buffer_, buffer_ + n);
    return traits_type::to_int_type(*gptr());
  }

 private:
  char buffer_[1 << 16];
};

// Writes standard output in large blocks.
class OutputBuffer : public std::streambuf {
 public:
  OutputBuffer() { setp(buffer_, buffer_ + sizeof buffer_); }
  ~OutputBuffer() override { flush(); }

 protected:
  int_type overflow(int_type c) override {
    if (!flush()) {
      return traits_type::eof();
    }
    if (!traits_type::eq_int_type(c, traits_type::eof())) {
      *pptr() = traits_type::to_char_type(c);
      pbump(1);
    }
    return traits_type::not_eof(c);
  }

  int sync() override { return flush() ? 0 : -1; }

 private:
  bool flush() {
    const char* p = pbase();
    while (p < pptr()) {
      ssize_t n = ::write(1, p, pptr() - p);
      if (n <= 0) {
        return false;
      }
      p += n;
    }
    setp(buffer_, buffer_ + sizeof buffer_);
    return true;
  }

  char buffer_[1 << 16];
};

InputBuffer* inputBuffer = nullptr;
OutputBuffer* outputBuffer = nullptr;

// Flushes standard output when the program exits.
struct FlushAtExit {
  ~FlushAtExit() {
    if (outputBuffer) {
      outputBuffer->pubsync();
    }
  }
} flushAtExit;

}  // namespace

// libc++'s own sync_with_stdio, which the linker renames.
bool real_sync_with_stdio(bool sync) __asm__("__real__ZNSt3__28ios_base15sync_with_stdioEb");

// The replacement for libc++'s sync_with_stdio.
extern "C" bool __wrap__ZNSt3__28ios_base15sync_with_stdioEb(bool sync) {
  bool previous = real_sync_with_stdio(sync);
  if (!sync && !inputBuffer) {
    std::fflush(stdout);
    static InputBuffer input;
    static OutputBuffer output;
    inputBuffer = &input;
    outputBuffer = &output;
    std::cin.rdbuf(&input);
    std::cout.rdbuf(&output);
  }
  return previous;
}
