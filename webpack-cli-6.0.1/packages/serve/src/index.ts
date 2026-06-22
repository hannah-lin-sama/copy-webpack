import { type Compiler, type cli } from "webpack";
import { type IWebpackCLI, type WebpackDevServerOptions } from "webpack-cli";

const WEBPACK_PACKAGE = process.env.WEBPACK_PACKAGE || "webpack";
const WEBPACK_DEV_SERVER_PACKAGE = process.env.WEBPACK_DEV_SERVER_PACKAGE || "webpack-dev-server";

type Problem = NonNullable<ReturnType<(typeof cli)["processArguments"]>>[0];

/**
 * 启动 webpack-dev-server 进行开发时的热重载服务
 */
class ServeCommand {
  async apply(cli: IWebpackCLI): Promise<void> {
    const loadDevServerOptions = () => {
      const devServer = require(WEBPACK_DEV_SERVER_PACKAGE);
      // 从 webpack-dev-server 的 JSON schema 中提取所有 devServer 配置选项
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = cli.webpack.cli.getArguments(devServer.schema);
      // New options format
      // { flag1: {}, flag2: {} }
      return Object.keys(options).map((key) => {
        options[key].name = key;

        return options[key];
      });
    };

    // 命令配置，注册 serve 命令    
    await cli.makeCommand(
      {
        name: "serve [entries...]",
        alias: ["server", "s"],
        description: "Run the webpack dev server and watch for source file changes while serving.",
        usage: "[entries...] [options]",
        pkg: "@webpack-cli/serve",
        dependencies: [WEBPACK_PACKAGE, WEBPACK_DEV_SERVER_PACKAGE],
      },
      // 回调1: 获取选项 
      async () => {
        let devServerFlags = [];

        cli.webpack = await cli.loadWebpack();

        try {
          devServerFlags = loadDevServerOptions();
        } catch (error) {
          cli.logger.error(
            `You need to install 'webpack-dev-server' for running 'webpack serve'.\n${error}`,
          );
          process.exit(2);
        }

        const builtInOptions = cli.getBuiltInOptions();

        return [...builtInOptions, ...devServerFlags];
      },
      // 回调2: 执行服务
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (entries: string[], options: any) => {

        // 获取内置的 webpack 配置选项和 devServer 配置选项
        // webpack 内置选项（mode, entry, output 等）
        const builtInOptions = cli.getBuiltInOptions();
        let devServerFlags = [];

        try {
          // devServer 选项（port, hot, live-reload 等）
          devServerFlags = loadDevServerOptions();
        } catch (_err) {
          // Nothing, to prevent future updates
        }

        // 创建分离容器
        // webpack 构建相关的 CLI 选项
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webpackCLIOptions: Record<string, any> = {};
        // devServer 服务器相关的 CLI 选项
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const devServerCLIOptions: Record<string, any> = {};

        // 需要特殊处理的选项处理器
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const processors: Array<(opts: Record<string, any>) => void> = [];

        for (const optionName in options) {
          // 转换为 kebab-case（如 mode → mode, noDevServer → no-dev-server）
          const kebabedOption = cli.toKebabCase(optionName);
          // 检查是否为 webpack 内置选项
          const isBuiltInOption = builtInOptions.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (builtInOption: any) => builtInOption.name === kebabedOption,
          );

          // webpack 选项
          if (isBuiltInOption) {
            webpackCLIOptions[optionName] = options[optionName];
          } else {
            // devServer 选项
            const needToProcess = devServerFlags.find(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (devServerOption: any) =>
                devServerOption.name === kebabedOption && devServerOption.processor,
            );

            if (needToProcess) {
              processors.push(needToProcess.processor);
            }

            devServerCLIOptions[optionName] = options[optionName];
          }
        }

        // 执行所有收集到的处理器
        for (const processor of processors) {
          processor(devServerCLIOptions);
        }

        // 创建编译器

        // 合并 entry 文件
        if (entries.length > 0) {
          webpackCLIOptions.entry = [...entries, ...(webpackCLIOptions.entry || [])];
        }

        webpackCLIOptions.argv = {
          ...options,
          env: { WEBPACK_SERVE: true, ...options.env },
        };

        webpackCLIOptions.isWatchingLikeCommand = true;

        // 创建编译器实例 
        const compiler = await cli.createCompiler(webpackCLIOptions);

        if (!compiler) {
          return;
        }

        // 启动 DevServer 

        const servers: (typeof DevServer)[] = [];

        // stdin 监听处理
        if (cli.needWatchStdin(compiler)) {
          process.stdin.on("end", () => {
            Promise.all(
              servers.map((server) => {
                return server.stop();
              }),
            ).then(() => {
              process.exit(0);
            });
          });
          process.stdin.resume();
        }

        // 检查 webpack-dev-server 安装
        const DevServer = require(WEBPACK_DEV_SERVER_PACKAGE);

        try {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          require(`${WEBPACK_DEV_SERVER_PACKAGE}/package.json`).version;
        } catch (err) {
          cli.logger.error(
            `You need to install 'webpack-dev-server' for running 'webpack serve'.\n${err}`,
          );
          process.exit(2);
        }

        // 处理多编译器配置
        const compilers = cli.isMultipleCompiler(compiler) ? compiler.compilers : [compiler];
        const possibleCompilers = compilers.filter(
          (compiler: Compiler) => compiler.options.devServer,
        );
        const compilersForDevServer =
          possibleCompilers.length > 0 ? possibleCompilers : [compilers[0]];
        const usedPorts: number[] = [];

        // 遍历每个编译器启动服务器
        for (const compilerForDevServer of compilersForDevServer) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          if (compilerForDevServer.options.devServer === false) {
            continue;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const args = devServerFlags.reduce((accumulator: Record<string, any>, flag: any) => {
            accumulator[flag.name] = flag;

            return accumulator;
          }, {});
          const values = Object.keys(devServerCLIOptions).reduce(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (accumulator: Record<string, any>, name: string) => {
              const kebabName = cli.toKebabCase(name);

              if (args[kebabName]) {
                accumulator[kebabName] = options[name];
              }

              return accumulator;
            },
            {},
          );
          const result = { ...(compilerForDevServer.options.devServer || {}) };
          const problems = (
            cli.webpack.cli && typeof cli.webpack.cli.processArguments === "function"
              ? cli.webpack.cli
              : DevServer.cli
          ).processArguments(args, result, values);

          if (problems) {
            const groupBy = (xs: Problem[], key: keyof Problem) => {
              return xs.reduce((rv: { [key: string]: Problem[] }, x: Problem) => {
                (rv[x[key]] = rv[x[key]] || []).push(x);

                return rv;
              }, {});
            };

            const problemsByPath = groupBy(problems, "path");

            for (const path in problemsByPath) {
              const problems = problemsByPath[path];

              for (const problem of problems) {
                cli.logger.error(
                  `${cli.capitalizeFirstLetter(problem.type.replace(/-/g, " "))}${
                    problem.value ? ` '${problem.value}'` : ""
                  } for the '--${problem.argument}' option${
                    problem.index ? ` by index '${problem.index}'` : ""
                  }`,
                );

                if (problem.expected) {
                  cli.logger.error(`Expected: '${problem.expected}'`);
                }
              }
            }

            process.exit(2);
          }

          const devServerOptions: WebpackDevServerOptions = result as WebpackDevServerOptions;

          if (devServerOptions.port) {
            const portNumber = Number(devServerOptions.port);

            if (usedPorts.find((port) => portNumber === port)) {
              throw new Error(
                "Unique ports must be specified for each devServer option in your webpack configuration. Alternatively, run only 1 devServer config using the --config-name flag to specify your desired config.",
              );
            }

            usedPorts.push(portNumber);
          }

          try {
            // 实例化并启动 webpack-dev-server
            const server = new DevServer(devServerOptions, compiler);

            // 启动 webpack-dev-server
            await server.start();

            // 存储启动的 webpack-dev-server 实例
            servers.push(server);
          } catch (error) {
            if (cli.isValidationError(error as Error)) {
              cli.logger.error((error as Error).message);
            } else {
              cli.logger.error(error);
            }

            process.exit(2);
          }
        }

        if (servers.length === 0) {
          cli.logger.error("No dev server configurations to run");
          process.exit(2);
        }
      },
    );
  }
}

export default ServeCommand;
