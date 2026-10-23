import peergos.server.Builder;
import peergos.shared.Crypto;
import peergos.shared.NetworkAccess;
import peergos.shared.user.UserContext;

import java.net.URI;
import java.util.*;

/** Test fixture for the end-to-end test against a LOCAL throw-away Peergos server: signs up the given users.
 *  The password comes from the environment (PEERGOS_TEST_PASSWORD), never from the command line.
 *
 *  PEERGOS_TEST_PASSWORD=... java -cp Peergos.jar tests/peergos/Setup.java http://localhost:8777 testuser [more users]
 */
public class Setup {
    public static void main(String[] args) throws Exception {
        String url = args[0];
        String password = System.getenv("PEERGOS_TEST_PASSWORD");
        if (password == null || password.isEmpty())
            throw new IllegalStateException("set PEERGOS_TEST_PASSWORD");
        Crypto crypto = Builder.initCrypto();
        for (String u : Arrays.asList(args).subList(1, args.length)) {
            NetworkAccess net = Builder.buildJavaNetworkAccess(URI.create(url).toURL(), false, Optional.empty(), Optional.empty()).join();
            try {
                UserContext.signUp(u, password, "", net, crypto).join();
                System.out.println("signed up " + u);
            } catch (Exception e) {
                UserContext.signIn(u, password, mfa -> null, net, crypto).join();
                System.out.println("signed in " + u);
            }
        }
        System.out.println("SETUP DONE");
        System.exit(0);
    }
}
