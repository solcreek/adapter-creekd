export {};

const publicOrigin = process.env.CREEK_NEXT_PUBLIC_ORIGIN;

if (publicOrigin) {
  const apply = () => {
    process.env.__NEXT_PRIVATE_ORIGIN = publicOrigin;
  };

  apply();

  const timer = setInterval(apply, 250);
  timer.unref();
}
