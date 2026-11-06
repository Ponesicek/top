import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const BACKDROP_CLASS = "fixed inset-0 z-50 bg-[rgba(20,16,12,0.32)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0";

const POPUP_CLASS =
  "fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-popover text-foreground shadow-[var(--shadow-popover-value),0_24px_64px_-16px_rgba(20,14,8,0.28)] outline-none transition-[scale,opacity,translate] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:translate-y-[calc(-50%+6px)] data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:translate-y-[calc(-50%+6px)] data-starting-style:scale-98 data-starting-style:opacity-0 motion-reduce:transition-none";

/**
 * Keys typed in a dialog stay in it: the app's shortcuts (Ctrl+1…9 switches bots) listen on the window and
 * would act behind it.
 */
const stopKeys = (e: React.KeyboardEvent) => e.stopPropagation();

const Dialog = DialogPrimitive.Root;

function DialogPopup({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className={BACKDROP_CLASS} data-slot="dialog-backdrop" />
      <DialogPrimitive.Popup className={cn(POPUP_CLASS, className)} data-slot="dialog-popup" onKeyDown={stopKeys} {...props}>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title className={cn("m-0 text-lg leading-[1.3] font-[650] tracking-[-0.02em]", className)} data-slot="dialog-title" {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description className={cn("-mt-1.5 text-sm leading-normal text-secondary-foreground", className)} data-slot="dialog-description" {...props} />;
}

function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 px-5.5 pt-5.5 pb-4.5", className)} data-slot="dialog-body" {...props} />;
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-0.5 flex justify-end gap-2", className)} data-slot="dialog-footer" {...props} />;
}

function DialogError({ className, ...props }: ComponentProps<"p">) {
  return <p role="alert" className={cn("-mt-1 text-small text-destructive-foreground", className)} data-slot="dialog-error" {...props} />;
}

/** A confirmation: no close on an outside click, and screen readers announce it as an alert. */
const AlertDialog = AlertDialogPrimitive.Root;

function AlertDialogPopup({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className={BACKDROP_CLASS} data-slot="alert-dialog-backdrop" />
      <AlertDialogPrimitive.Popup className={cn(POPUP_CLASS, className)} data-slot="alert-dialog-popup" onKeyDown={stopKeys} {...props}>
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

const DialogClose = DialogPrimitive.Close;
const AlertDialogClose = AlertDialogPrimitive.Close;

export { AlertDialog, AlertDialogClose, AlertDialogPopup, Dialog, DialogBody, DialogClose, DialogDescription, DialogError, DialogFooter, DialogPopup, DialogTitle };
